import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { BrowserEvidence, RunRecord } from "../shared/contracts";
import { cli, artifacts, verifyEvidence } from "./common";
const { request } = cli("AGENT_API_TOKEN");
const task = `AgentPilot-${randomUUID()}`;
const instruction = `Open https://demo.playwright.dev/todomvc, add a task named ${task}, mark it complete, and verify it with page_snapshot.`;
const init = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({ instruction }),
};
const accepted = (await (await request("/agent/run", init)).json()) as {
  run_id: string;
};
const duplicate = (await (await request("/agent/run", init)).json()) as {
  run_id: string;
};
assert.equal(accepted.run_id, duplicate.run_id, "Submission executed twice");
const deadline = Date.now() + 240_000;
let run: RunRecord;
while (true) {
  run = (await (await request(`/runs/${accepted.run_id}`)).json()) as RunRecord;
  if (!["queued", "running"].includes(run.status)) break;
  assert.ok(
    Date.now() < deadline,
    `Polling deadline exceeded; inspect run ${accepted.run_id} before retrying.`,
  );
  await setTimeout(2000);
}
let evidence: BrowserEvidence;
try {
  evidence = (await (
    await request(`/runs/${run.run_id}/evidence`)
  ).json()) as BrowserEvidence;
} catch {
  throw new Error(
    `Run ${run.run_id} ended ${run.status} (${run.error_code ?? "no evidence"}).`,
  );
}
const directory = await artifacts(run.run_id, evidence, run);
assert.equal(
  run.status,
  "completed",
  `Run failed: ${run.error_code ?? run.result?.summary}. Evidence: ${directory}`,
);
for (const name of ["open_page", "fill", "press_key", "click", "page_snapshot"])
  assert.ok(
    run.tools.some((t) => t.name === name && !t.is_error),
    `No successful ${name} tool call recorded`,
  );
verifyEvidence(evidence, task);
console.log(
  `PASS: cloud agent verified the completed task. Evidence: ${directory}`,
);
