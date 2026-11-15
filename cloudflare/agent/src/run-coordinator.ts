import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import { z } from "zod";
import {
  AppError,
  LIMITS,
  errorResponse,
  failure,
  json,
  readJson,
  type BrowserEvidence,
  type RunRecord,
} from "../../shared/contracts";
import {
  browserApi,
  browserEndpoint,
  captureEvidence,
  connectMcp,
  type FetchLike,
} from "./mcp-client";
import { runTask } from "./runner";
import { saveEvidence, loadEvidence } from "./evidence";

export interface AgentEnv {
  RUN_COORDINATOR: DurableObjectNamespace<RunCoordinator>;
  MCP_BROWSER: Fetcher;
  BROWSER_WORKER_URL: string;
  AGENT_API_TOKEN: string;
  MCP_API_TOKEN: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  VERSION?: { id: string };
}
interface StoredRun extends RunRecord {
  session: string;
  idempotency_key: string;
}
function publicRun(run: StoredRun) {
  const { session: _, idempotency_key: __, instruction: ___, ...record } = run;
  return record;
}
const inputSchema = z
  .object({ instruction: z.string().trim().min(1).max(4000) })
  .strict();
export class RunCoordinator extends DurableObject<AgentEnv> {
  private pending: Promise<unknown> = Promise.resolve();
  private fetchBrowser: FetchLike = (input, init) => {
    const request = new Request(input, init);
    // Service bindings can retain the initiating request's Host header. MCP's
    // DNS-rebinding protection requires it to match the destination URL.
    request.headers.set("Host", new URL(request.url).host);
    return this.env.MCP_BROWSER.fetch(request);
  };
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      try {
        const path = new URL(request.url).pathname;
        await this.prune();
        if (path === "/agent/run" && request.method === "POST")
          return await this.submit(request);
        if (path === "/runs/latest" && request.method === "GET") {
          const runs = await this.ctx.storage.list<StoredRun>({
            prefix: "run:",
          });
          const latest = [...runs.values()].sort(
            (a, b) => b.created_at - a.created_at,
          )[0];
          if (!latest) throw new AppError("not_found", 404);
          return json(publicRun(latest));
        }
        const match = /^\/runs\/([a-f0-9-]{36})(\/evidence)?$/.exec(path);
        if (match && request.method === "GET") {
          const run = await this.ctx.storage.get<StoredRun>(`run:${match[1]}`);
          if (!run) throw new AppError("not_found", 404);
          if (match[2]) {
            const evidence = await loadEvidence(this.ctx.storage, run.run_id);
            if (!evidence) throw new AppError("evidence_unavailable", 404);
            return json(evidence);
          }
          return json(publicRun(run));
        }
        throw new AppError("not_found", 404);
      } catch (e) {
        return errorResponse(e);
      }
    });
  }
  private async submit(request: Request): Promise<Response> {
    const parsed = inputSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("invalid_instruction");
    const key = request.headers.get("Idempotency-Key") ?? "";
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new AppError("idempotency_key_required");
    const existing = await this.ctx.storage.get<StoredRun>(`idem:${key}`);
    if (existing) {
      if (existing.instruction !== parsed.data.instruction)
        throw new AppError("idempotency_conflict", 409);
      return json(
        {
          run_id: existing.run_id,
          status:
            (await this.ctx.storage.get<StoredRun>(`run:${existing.run_id}`))
              ?.status ?? existing.status,
        },
        202,
      );
    }
    if (await this.ctx.storage.get("active")) throw new AppError("busy", 409);
    const day = new Date().toISOString().slice(0, 10);
    const quota = await this.ctx.storage.get<{ day: string; count: number }>(
      "quota",
    );
    const count = quota?.day === day ? quota.count : 0;
    if (count >= LIMITS.runsPerDay) throw new AppError("daily_run_limit", 429);
    if (
      !this.env.OPENAI_API_KEY ||
      this.env.OPENAI_API_KEY.startsWith("REPLACE_")
    )
      throw new AppError("openai_key_not_configured", 503);
    const api = browserApi(
      this.fetchBrowser,
      this.env.MCP_API_TOKEN,
      this.env.BROWSER_WORKER_URL,
    );
    const lease = (await (await api("/sessions", "POST")).json()) as {
      session_id: string;
    };
    const run: StoredRun = {
      run_id: crypto.randomUUID(),
      session: lease.session_id,
      idempotency_key: key,
      instruction: parsed.data.instruction,
      created_at: Date.now(),
      status: "queued",
      tools: [],
      tokens: 0,
      revision: this.env.VERSION?.id ?? "local",
    };
    try {
      await this.ctx.storage.transaction(async (tx) => {
        await tx.put({
          [`run:${run.run_id}`]: run,
          [`idem:${key}`]: run,
          active: run.run_id,
          quota: { day, count: count + 1 },
        });
        await tx.setAlarm(Date.now() + 1);
      });
    } catch (e) {
      await api("/sessions", "DELETE", lease.session_id).catch(() => {});
      throw e;
    }
    return json({ run_id: run.run_id, status: run.status }, 202);
  }
  async alarm(): Promise<void> {
    const active = await this.ctx.storage.get<string>("active");
    if (!active) {
      await this.prune();
      return;
    }
    const run = await this.ctx.storage.get<StoredRun>(`run:${active}`);
    if (!run) {
      await this.ctx.storage.delete("active");
      return;
    }
    const api = browserApi(
      this.fetchBrowser,
      this.env.MCP_API_TOKEN,
      this.env.BROWSER_WORKER_URL,
    );
    // Alarms are at-least-once. A persisted running marker forbids replay.
    if (run.status !== "queued") {
      run.status = "interrupted";
      run.error_code = "execution_interrupted";
      run.result = failure(run.error_code);
      await this.finish(run, api);
      return;
    }
    run.status = "running";
    run.started_at = Date.now();
    await this.ctx.storage.put(`run:${run.run_id}`, run);
    // Recovery watchdog if the isolate disappears mid-task.
    await this.ctx.storage.setAlarm(
      Date.now() + LIMITS.leaseMs + LIMITS.idleMs + 10_000,
    );
    let client: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
      client = await connectMcp(
        browserEndpoint(this.env.BROWSER_WORKER_URL, "/mcp"),
        this.env.MCP_API_TOKEN,
        run.session,
        this.fetchBrowser,
      );
      run.result = await runTask({
        instruction: run.instruction,
        client,
        openai: new OpenAI({
          apiKey: this.env.OPENAI_API_KEY,
          maxRetries: 0,
          timeout: 45_000,
        }),
        model: this.env.OPENAI_MODEL,
        signal: AbortSignal.timeout(
          Math.max(1, LIMITS.runMs - (Date.now() - run.started_at)),
        ),
        onProgress: async (progress) => {
          run.tools = progress.tools;
          run.tokens = progress.tokens;
          await this.ctx.storage.put(`run:${run.run_id}`, run);
          console.log(
            JSON.stringify({
              run_id: run.run_id,
              tools: run.tools.length,
              tokens: run.tokens,
            }),
          );
        },
      });
      run.status = run.result.status;
    } catch (e) {
      run.error_type = e instanceof Error ? e.constructor.name : "UnknownError";
      run.error_code =
        e instanceof AppError
          ? e.code
          : e instanceof Error && /abort|timeout/i.test(e.name)
            ? "task_timeout"
            : !client
              ? "mcp_connection_failed"
              : "execution_failed";
      console.error(
        JSON.stringify({
          run_id: run.run_id,
          error_type: run.error_type,
          error_code: run.error_code,
        }),
      );
      run.result = failure(run.error_code);
      run.status = "failed";
    } finally {
      try {
        const evidence = await captureEvidence(
          this.fetchBrowser,
          this.env.MCP_API_TOKEN,
          run.session,
          this.env.BROWSER_WORKER_URL,
        );
        await saveEvidence(this.ctx.storage, run.run_id, evidence);
      } catch {
        if (run.status === "completed") {
          run.status = "failed";
          run.error_code = "evidence_capture_failed";
          run.result = failure(run.error_code);
        }
      }
      await client?.close().catch(() => {});
      await this.finish(run, api);
    }
  }
  private async finish(
    run: StoredRun,
    api: ReturnType<typeof browserApi>,
  ): Promise<void> {
    try {
      await api("/sessions", "DELETE", run.session);
    } catch {
      run.status = "failed";
      run.error_code = "cleanup_unconfirmed";
      run.result = failure(run.error_code);
    }
    await this.exclusive(async () => {
      run.finished_at = Date.now();
      await this.ctx.storage.transaction(async (tx) => {
        await tx.put(`run:${run.run_id}`, run);
        await tx.delete("active");
        await tx.setAlarm(Date.now() + LIMITS.retentionMs);
      });
    });
  }
  private async prune(): Promise<void> {
    const runs = await this.ctx.storage.list<StoredRun>({ prefix: "run:" });
    for (const [key, run] of runs) {
      if (
        run.finished_at &&
        run.finished_at <= Date.now() - LIMITS.retentionMs
      ) {
        await this.ctx.storage.delete([
          key,
          `idem:${run.idempotency_key}`,
          `evidence:${run.run_id}`,
        ]);
        const images = await this.ctx.storage.list({
          prefix: `image:${run.run_id}:`,
        });
        if (images.size) await this.ctx.storage.delete([...images.keys()]);
      }
    }
    if (!(await this.ctx.storage.get("active"))) {
      const remaining = await this.ctx.storage.list<StoredRun>({
        prefix: "run:",
      });
      const deadlines = [...remaining.values()].flatMap((r) =>
        r.finished_at ? [r.finished_at + LIMITS.retentionMs] : [],
      );
      if (deadlines.length)
        await this.ctx.storage.setAlarm(
          Math.max(Date.now() + 1, Math.min(...deadlines)),
        );
      else await this.ctx.storage.deleteAlarm();
    }
  }
}
