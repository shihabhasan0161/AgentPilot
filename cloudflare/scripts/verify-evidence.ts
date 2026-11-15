import { readFile } from "node:fs/promises";
import { verifyEvidence } from "./common";
const [file, task] = process.argv.slice(2);
if (!file || !task)
  throw new Error(
    "Usage: npm run verify:evidence -- artifacts/<id>/evidence.json <exact-task-name>",
  );
verifyEvidence(JSON.parse(await readFile(file, "utf8")), task);
console.log(
  "PASS: snapshot and independent DOM observations match the exact completed task.",
);
