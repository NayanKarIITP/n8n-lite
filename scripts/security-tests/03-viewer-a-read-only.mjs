// 03-viewer-a-read-only.mjs
import { gqlAs, assert, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 3: Org A viewer can read but cannot modify/trigger");
  if (!requireEnv(["viewerAJwt", "orgAId", "workflowAId"])) return "skipped";

  const readResult = await gqlAs(
    env.viewerAJwt,
    `query($orgId: uuid!) { workflows(where: { org_id: { _eq: $orgId } }) { id name } }`,
    { orgId: env.orgAId }
  );
  assert(!readResult.errors, "viewer can read workflows without error");
  assert(Array.isArray(readResult.data?.workflows), "viewer receives workflow data");

  const writeResult = await gqlAs(
    env.viewerAJwt,
    `mutation($orgId: uuid!) { insert_workflows_one(object: { org_id: $orgId, name: "should-fail" }) { id } }`,
    { orgId: env.orgAId }
  );
  assertDenied(writeResult, "viewer cannot create a workflow (insert permission denies non-owner/editor)");

  const triggerResult = await gqlAs(
    env.viewerAJwt,
    `mutation($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { workflow_run_id } }`,
    { id: env.workflowAId }
  );
  assertDenied(triggerResult, "viewer cannot trigger a workflow run (Action handler rejects role=viewer)");

  return "passed";
}
