import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryState } from "../../shared/test-storage";
const fake = vi.hoisted(() => ({
  connectMcp: vi.fn(),
  captureEvidence: vi.fn(),
  runTask: vi.fn(),
}));
vi.mock("../src/runner", () => ({ runTask: fake.runTask }));
vi.mock("../src/mcp-client", async (original) => ({
  ...(await original<typeof import("../src/mcp-client")>()),
  connectMcp: fake.connectMcp,
  captureEvidence: fake.captureEvidence,
}));
import { RunCoordinator, type AgentEnv } from "../src/run-coordinator";
import { loadEvidence, saveEvidence } from "../src/evidence";
import type { BrowserEvidence } from "../../shared/contracts";
import { LIMITS } from "../../shared/contracts";

function setup(browserUrl = "https://browser.example.com") {
  const state = memoryState();
  const remote = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(
      new Request(input, init).method === "POST"
        ? { session_id: "lease" }
        : { status: "closed" },
    ),
  );
  const env = {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-4.1-mini",
    MCP_API_TOKEN: "x".repeat(40),
    BROWSER_WORKER_URL: browserUrl,
    MCP_BROWSER: { fetch: remote },
  } as unknown as AgentEnv;
  const coordinator = new RunCoordinator(state.ctx, env);
  const submit = (key = "test-key-123", instruction = "test") =>
    coordinator.fetch(
      new Request("https://test/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ instruction }),
      }),
    );
  return { state, remote, coordinator, submit };
}
beforeEach(() => {
  vi.resetAllMocks();
  fake.connectMcp.mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
  });
  fake.captureEvidence.mockResolvedValue({
    url: "https://demo.playwright.dev/todomvc",
    title: "TodoMVC",
    snapshot: "- task Test",
    todos: [{ text: "Test", completed: true }],
    captured_at: new Date().toISOString(),
    truncated: false,
  });
  fake.runTask.mockResolvedValue({
    status: "completed",
    summary: "Done",
    evidence: ["Test"],
  });
});
describe("run coordination", () => {
  it("uses the configured browser origin for leases, MCP, evidence, and cleanup", async () => {
    const origin = "https://custom-browser.example.com";
    const s = setup(origin);
    await s.submit();
    await s.coordinator.alarm();
    for (const [input] of s.remote.mock.calls) {
      const request = new Request(input);
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.headers.get("Host")).toBe(new URL(origin).host);
    }
    expect(fake.connectMcp).toHaveBeenCalledWith(
      `${origin}/mcp`, expect.any(String), "lease", expect.any(Function),
    );
    expect(fake.captureEvidence).toHaveBeenCalledWith(
      expect.any(Function), expect.any(String), "lease", origin,
    );
  });
  it("rejects missing or unsafe browser origins before acquiring a lease", async () => {
    for (const origin of ["", "not-a-url", "https://user:pass@browser.example.com", "http://browser.example.com", "https://browser.example.com/path", "https://browser.example.com?token=secret"]) {
      const s = setup(origin);
      expect((await s.submit()).status).toBe(503);
      expect(s.remote).not.toHaveBeenCalled();
    }
  });
  it("finds the newest retained run without exposing its instruction or credentials", async () => {
    const s = setup();
    const request = () =>
      s.coordinator.fetch(new Request("https://test/runs/latest"));
    expect((await request()).status).toBe(404);
    const accepted = (await (await s.submit()).json()) as { run_id: string };
    const newest = s.state.data.get(`run:${accepted.run_id}`) as Record<
      string,
      unknown
    >;
    s.state.data.set("run:older", {
      ...newest,
      run_id: "older",
      created_at: Number(newest.created_at) - 1000,
    });
    const record = (await (await request()).json()) as Record<string, unknown>;
    expect(record.run_id).toBe(accepted.run_id);
    expect(record.status).toBe("queued");
    expect(record).not.toHaveProperty("instruction");
    expect(record).not.toHaveProperty("session");
    expect(record).not.toHaveProperty("idempotency_key");
    expect(fake.runTask).not.toHaveBeenCalled();
  });
  it("deduplicates, rejects overlap, and detects changed idempotency payloads", async () => {
    const s = setup();
    const a = (await (await s.submit()).json()) as { run_id: string };
    const b = (await (await s.submit()).json()) as { run_id: string };
    expect(a.run_id).toBe(b.run_id);
    expect(s.remote).toHaveBeenCalledOnce();
    expect((await s.submit("other-key")).status).toBe(409);
    expect((await s.submit("test-key-123", "changed")).status).toBe(409);
  });
  it("captures evidence before cleanup and publishes terminal status", async () => {
    const s = setup();
    const run = (await (await s.submit()).json()) as { run_id: string };
    await s.coordinator.alarm();
    const record = (await (
      await s.coordinator.fetch(new Request(`https://test/runs/${run.run_id}`))
    ).json()) as Record<string, unknown>;
    expect(record.status).toBe("completed");
    expect(record).not.toHaveProperty("session");
    expect(fake.captureEvidence).toHaveBeenCalledOnce();
    expect(s.state.data.has("active")).toBe(false);
    expect(new Request(s.remote.mock.calls.at(-1)![0]).method).toBe("DELETE");
  });
  it("cleans up execution failures and marks interrupted runs without replay", async () => {
    const s = setup();
    const run = (await (await s.submit()).json()) as { run_id: string };
    const stored = s.state.data.get(`run:${run.run_id}`) as Record<
      string,
      unknown
    >;
    stored.status = "running";
    await s.coordinator.alarm();
    expect(fake.runTask).not.toHaveBeenCalled();
    expect(
      (s.state.data.get(`run:${run.run_id}`) as Record<string, unknown>).status,
    ).toBe("interrupted");
    const f = setup();
    await f.submit();
    fake.runTask.mockRejectedValue(new Error("model failure"));
    await f.coordinator.alarm();
    expect(new Request(f.remote.mock.calls.at(-1)![0]).method).toBe("DELETE");
  });
  it("enforces daily limits before acquiring a browser", async () => {
    const s = setup();
    s.state.data.set("quota", {
      day: new Date().toISOString().slice(0, 10),
      count: LIMITS.runsPerDay,
    });
    expect((await s.submit()).status).toBe(429);
    expect(s.remote).not.toHaveBeenCalled();
  });
  it("does not publish success when evidence or cleanup fails", async () => {
    const s = setup();
    const accepted = (await (await s.submit()).json()) as { run_id: string };
    fake.captureEvidence.mockRejectedValue(new Error("capture failed"));
    await s.coordinator.alarm();
    expect(
      (s.state.data.get(`run:${accepted.run_id}`) as Record<string, unknown>)
        .error_code,
    ).toBe("evidence_capture_failed");
    const c = setup();
    const run = (await (await c.submit()).json()) as { run_id: string };
    c.remote.mockResolvedValue(
      Response.json({ error: "cleanup_unconfirmed" }, { status: 503 }),
    );
    await c.coordinator.alarm();
    expect(
      (c.state.data.get(`run:${run.run_id}`) as Record<string, unknown>)
        .error_code,
    ).toBe("cleanup_unconfirmed");
  });
  it("expires run results, evidence, and idempotency keys together", async () => {
    const s = setup();
    const run = (await (await s.submit()).json()) as { run_id: string };
    await s.coordinator.alarm();
    const record = s.state.data.get(`run:${run.run_id}`) as Record<
      string,
      unknown
    >;
    record.finished_at = Date.now() - 86400001;
    expect(
      (
        await s.coordinator.fetch(
          new Request(`https://test/runs/${run.run_id}`),
        )
      ).status,
    ).toBe(404);
    expect(s.state.data.has("idem:test-key-123")).toBe(false);
    expect(s.state.data.has(`evidence:${run.run_id}`)).toBe(false);
  });
  it("stores screenshots in bounded chunks and reconstructs them", async () => {
    const s = memoryState();
    const evidence = {
      snapshot: "test",
      screenshot: { data: "a".repeat(700000), mimeType: "image/jpeg" },
    } as BrowserEvidence;
    await saveEvidence(s.ctx.storage, "id", evidence);
    expect(
      (await loadEvidence(s.ctx.storage, "id"))?.screenshot?.data,
    ).toHaveLength(700000);
    expect(
      [...s.data.entries()]
        .filter(([key]) => key.startsWith("image:"))
        .every(([, value]) => (value as string).length <= 64000),
    ).toBe(true);
  });
});
