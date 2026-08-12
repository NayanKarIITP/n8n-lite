// 08-unauthorized-cannot-approve.mjs
//
// Org B owner (not a member of Org A) tries to approve an Org A approval
// gate by guessing/copying its step_run_id. Also checks that an Org A
// viewer (a member, but wrong role) is rejected.
import { gqlAs, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 9: Unauthorized users cannot approve");
  if (!requireEnv(["ownerBJwt", "viewerAJwt", "stepRunApprovalGateId"])) return "skipped";

  const crossOrgAttempt = await gqlAs(
    env.ownerBJwt,
    `mutation($id: uuid!) { approveStep(step_run_id: $id) { status } }`,
    { id: env.stepRunApprovalGateId }
  );
  assertDenied(crossOrgAttempt, "Org B owner cannot approve Org A's approval gate by ID (not a member => 404)");

  const wrongRoleAttempt = await gqlAs(
    env.viewerAJwt,
    `mutation($id: uuid!) { approveStep(step_run_id: $id) { status } }`,
    { id: env.stepRunApprovalGateId }
  );
  assertDenied(wrongRoleAttempt, "Org A viewer cannot approve (member, but role does not permit approval)");

  return "passed";
}
