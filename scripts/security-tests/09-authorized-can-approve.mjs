// 09-authorized-can-approve.mjs
//
// Positive-path check: an Org A owner (or editor, per assignment wording)
// CAN approve a paused approval_gate belonging to their own org. Requires
// a workflow_run that has actually reached `paused` — trigger the demo
// workflow first (see README "Final scenario") and export
// TEST_APPROVAL_STEP_RUN_ID from the resulting step_runs row before
// running this script.
import { gqlAs, assert, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 10: Authorized user (Org A owner) can approve");
  if (!requireEnv(["ownerAJwt", "stepRunApprovalGateId"])) return "skipped";

  const result = await gqlAs(
    env.ownerAJwt,
    `mutation($id: uuid!) { approveStep(step_run_id: $id) { step_run_id workflow_run_id status } }`,
    { id: env.stepRunApprovalGateId }
  );

  assert(!result.errors, "no GraphQL/Action errors for owner approving their own org's step");
  assert(
    result.data?.approveStep?.status &&
      ["running", "completed", "failed"].includes(result.data.approveStep.status),
    "workflow_run status advances out of 'paused' after approval (resumed execution)"
  );

  return "passed";
}
