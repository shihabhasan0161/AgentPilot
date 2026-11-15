import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectMcp } from "../agent/src/mcp-client";
import type { BrowserEvidence } from "../shared/contracts";
import { cli, artifacts, verifyEvidence } from "./common";
const { url, token, request } = cli("MCP_API_TOKEN");
const task = `AgentPilot-${randomUUID()}`;
const lease = (await (
  await request("/sessions", { method: "POST" })
).json()) as { session_id: string };
let client: Awaited<ReturnType<typeof connectMcp>> | undefined;
try {
  client = await connectMcp(
    new URL("/mcp", url.origin).href,
    token,
    lease.session_id,
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client!.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 45_000 },
    );
    assert.notEqual(result.isError, true, `Tool failed: ${name}`);
    return (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  };
  await call("open_page", { url: "https://demo.playwright.dev/todomvc" });
  const initial = (await (
    await request("/sessions/evidence", {}, lease.session_id)
  ).json()) as BrowserEvidence;
  assert.equal(
    initial.todos.length,
    0,
    "Fresh session contains previous task data",
  );
  await call("fill", { label: "What needs to be done?", value: task });
  await call("press_key", { key: "Enter" });
  const snapshot = await call("page_snapshot");
  assert.ok(snapshot.includes(task));
  const checkbox = /checkbox(?: "([^"\n]*)")?/.exec(snapshot);
  assert.ok(checkbox, "No checkbox found in accessibility snapshot");
  await call("click", { role: "checkbox", name: checkbox[1] ?? "" });
  const final = (await (
    await request("/sessions/evidence", {}, lease.session_id)
  ).json()) as BrowserEvidence;
  verifyEvidence(final, task);
  const directory = await artifacts(task, final);
  const invalid = await client.callTool({
    name: "open_page",
    arguments: { url: "http://127.0.0.1" },
  });
  assert.equal(invalid.isError, true, "Disallowed URL must fail");
  console.log(
    `PASS: deployed MCP added and completed exactly one task. Evidence: ${directory}`,
  );
} finally {
  try {
    await client?.close();
  } finally {
    await request("/sessions", { method: "DELETE" }, lease.session_id);
  }
}
