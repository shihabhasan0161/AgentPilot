import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import type { BrowserEvidence } from "../shared/contracts";

export function workerUrl(args = process.argv.slice(2), environmentUrl?: string): URL {
  // Accept a positional URL too: some npm/PowerShell combinations consume --url
  // before forwarding arguments to the script.
  const { values, positionals } = parseArgs({
    args,
    options: { url: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1 || (values.url && positionals.length))
    throw new Error(
      "Supply exactly one worker URL, either positional or with --url.",
    );
  const address = values.url ?? positionals[0] ?? environmentUrl;
  if (!address)
    throw new Error(
      "Supply a worker URL with --url, a positional argument, or the worker URL environment variable.",
    );
  const url = new URL(address);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !localHttp)
  )
    throw new Error("Use HTTPS or localhost and keep credentials out of URLs.");
  return url;
}
export function cli(tokenName: string) {
  const urlName = tokenName === "AGENT_API_TOKEN" ? "AGENT_WORKER_URL" : "BROWSER_WORKER_URL";
  const url = workerUrl(process.argv.slice(2), process.env[urlName]);
  const token = process.env[tokenName];
  if (!token || token.length < 32)
    throw new Error(`Set ${tokenName} in your environment.`);
  const request = async (
    path: string,
    init: RequestInit = {},
    session?: string,
  ) => {
    const response = await fetch(new URL(path, url.origin), {
      ...init,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(session ? { "X-AgentPilot-Session": session } : {}),
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new Error(
        `Request failed: HTTP ${response.status} ${await response.text()}`,
      );
    return response;
  };
  return { url, token, request };
}
export function verifyEvidence(
  evidence: BrowserEvidence,
  task: string,
  completed = true,
): void {
  assert.equal(new URL(evidence.url).hostname, "demo.playwright.dev");
  assert.equal(evidence.truncated, false, "Final snapshot was truncated");
  assert.ok(
    evidence.snapshot.includes(task),
    "Task missing from final accessibility snapshot",
  );
  const matches = evidence.todos.filter((todo) => todo.text === task);
  assert.equal(
    matches.length,
    1,
    "Expected exactly one task with this unique name",
  );
  assert.equal(
    matches[0].completed,
    completed,
    "Task completion state differs from expected",
  );
}
export async function artifacts(
  id: string,
  evidence: BrowserEvidence,
  record?: unknown,
): Promise<string> {
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  const directory = resolve("artifacts", id);
  await mkdir(directory, { recursive: true });
  const { screenshot, ...text } = evidence;
  await writeFile(
    resolve(directory, "evidence.json"),
    JSON.stringify(text, null, 2),
  );
  if (screenshot)
    await writeFile(
      resolve(directory, "screenshot.jpg"),
      Buffer.from(screenshot.data, "base64"),
    );
  if (record)
    await writeFile(
      resolve(directory, "run.json"),
      JSON.stringify(record, null, 2),
    );
  return directory;
}
