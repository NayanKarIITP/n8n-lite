// scripts/security-tests/run-all.mjs
//
// Runs all numbered test scripts in this directory in order and prints a
// pass/fail/skipped summary. Any test whose required env vars aren't set
// is reported as SKIPPED rather than silently omitted — see README
// "Database security testing" for how to populate them from real seeded
// users against a real Hasura endpoint.
//
// Usage: npm run test:security
// (requires HASURA_GRAPHQL_ENDPOINT and the TEST_* env vars from
// .env.example / README to be exported in your shell first)

import { run as t01 } from "./01-owner-a-can-access-org-a.mjs";
import { run as t02 } from "./02-editor-a-can-access-permitted-data.mjs";
import { run as t03 } from "./03-viewer-a-read-only.mjs";
import { run as t04 } from "./04-cross-org-isolation.mjs";
import { run as t05 } from "./05-editor-cannot-create-db-write.mjs";
import { run as t06 } from "./06-editor-cannot-create-webhook-trigger.mjs";
import { run as t07 } from "./07-editor-cannot-create-notify.mjs";
import { run as t08 } from "./08-unauthorized-cannot-approve.mjs";
import { run as t09 } from "./09-authorized-can-approve.mjs";
import { run as t10 } from "./10-quota-blocks-execution.mjs";

const tests = [t01, t02, t03, t04, t05, t06, t07, t08, t09, t10];

const results = { passed: 0, failed: 0, skipped: 0 };

for (const test of tests) {
  try {
    const outcome = await test();
    results[outcome] = (results[outcome] || 0) + 1;
  } catch (err) {
    console.log("  \x1b[31m✗ FAILED:\x1b[0m " + err.message);
    results.failed += 1;
  }
  console.log("");
}

console.log("=".repeat(50));
console.log(
  `Passed: ${results.passed}  Failed: ${results.failed}  Skipped: ${results.skipped}`
);
if (results.skipped > 0) {
  console.log(
    "Some tests were skipped because test env vars were not set. " +
      "This run does NOT constitute verification of those requirements."
  );
}
process.exit(results.failed > 0 ? 1 : 0);
