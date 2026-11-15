import { z } from "zod";

export const LIMITS = {
  runMs: 120_000,
  leaseMs: 150_000,
  idleMs: 60_000,
  sessionSpacingMs: 20_000,
  maxTurns: 20,
  maxTools: 20,
  maxTokens: 60_000,
  outputTokens: 1000,
  runsPerDay: 50,
  retentionMs: 86_400_000,
  snapshotChars: 24_000,
  transcriptChars: 100_000,
  screenshotBytes: 512 * 1024,
  bodyBytes: 8192,
} as const;
export const taskResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().max(2000),
  evidence: z.array(z.string().max(2000)).max(20),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
export type RunStatus =
  "queued" | "running" | TaskResult["status"] | "interrupted";
export interface ToolEvent {
  name: string;
  elapsed_ms: number;
  is_error: boolean;
  error_code?: string;
}
export interface BrowserEvidence {
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
  todos: { text: string; completed: boolean }[];
  captured_at: string;
  screenshot?: { data: string; mimeType: "image/jpeg" };
  screenshot_error?: string;
}
export interface RunRecord {
  run_id: string;
  status: RunStatus;
  instruction: string;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  result?: TaskResult;
  error_code?: string;
  tools: ToolEvent[];
  tokens: number;
  revision: string;
  error_type?: string;
}
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
export function errorResponse(error: unknown): Response {
  // Durable Object RPC preserves Error.message, but not custom Error fields.
  const remoteCodes: Record<string, number> = {
    busy: 409,
    invalid_session: 403,
    session_expired: 410,
    browser_session_lost: 410,
    browser_rate_limit: 429,
    cleanup_unconfirmed: 503,
    allowlist_required: 503,
    invalid_allowlist: 503,
    too_many_domains: 503,
    browser_not_open: 409,
    destination_not_allowed: 403,
    navigation_blocked: 403,
    invalid_url: 400,
    verification_timeout: 408,
  };
  const message = error instanceof Error ? error.message : "";
  const e =
    error instanceof AppError
      ? error
      : remoteCodes[message]
        ? new AppError(message, remoteCodes[message])
        : new AppError("internal_error", 500);
  return json({ error: e.code }, e.status);
}
export async function authorize(
  request: Request,
  token: string | undefined,
): Promise<void> {
  if (!token || token.length < 32 || token.startsWith("REPLACE_"))
    throw new AppError("secret_not_configured", 503);
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 512) throw new AppError("unauthorized", 401);
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([
    digest(supplied),
    digest(`Bearer ${token}`),
  ]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) throw new AppError("unauthorized", 401);
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.includes("application/json"))
    throw new AppError("json_required", 415);
  if (Number(request.headers.get("Content-Length")) > LIMITS.bodyBytes)
    throw new AppError("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.bodyBytes) {
        await reader.cancel();
        throw new AppError("body_too_large", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("invalid_json");
  }
}
export function boundedText(
  text: string,
  max: number = LIMITS.snapshotChars,
): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[TRUNCATED: size limit]`;
}
export function failure(code: string): TaskResult {
  return {
    status: "failed",
    summary: `Task stopped (${code}). Previous actions may have completed. Inspect the evidence before retrying.`,
    evidence: [],
  };
}
