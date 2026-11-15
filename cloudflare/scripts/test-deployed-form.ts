import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectMcp } from "../agent/src/mcp-client";
import type { BrowserEvidence } from "../shared/contracts";
import { cli, artifacts } from "./common";

// Read-only diagnostic: never fill a field, click Submit, or call a model.
const { url, token, request } = cli("MCP_API_TOKEN");
const formUrl = process.env.TEST_FORM_URL;
const field = process.env.TEST_FIELD_LABEL ?? "Enter name";
if (!formUrl || new URL(formUrl).hostname !== "docs.google.com")
  throw new Error("Set TEST_FORM_URL to the Google Forms page to inspect.");
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
  const opened = await client.callTool(
    { name: "open_page", arguments: { url: formUrl } },
    undefined,
    { timeout: 45_000 },
  );
  assert.notEqual(opened.isError, true, "Opening the form failed");
  const evidence = (await (
    await request("/sessions/evidence", {}, lease.session_id)
  ).json()) as BrowserEvidence;
  const directory = await artifacts(`form-${randomUUID()}`, evidence);
  const matching = evidence.snapshot
    .split("\n")
    .filter((line) => line.includes(`textbox ${JSON.stringify(field)}`));
  assert.equal(
    matching.length,
    1,
    `Expected one textbox named ${JSON.stringify(field)}. Evidence: ${directory}`,
  );
  assert.ok(
    !matching[0].includes("[disabled]"),
    `Textbox is still disabled. Check script dependencies. Evidence: ${directory}`,
  );
  console.log(
    `PASS: the deployed form textbox is enabled. No values entered and no form submitted. Evidence: ${directory}`,
  );
} finally {
  try {
    await client?.close();
  } finally {
    await request("/sessions", { method: "DELETE" }, lease.session_id);
  }
}
