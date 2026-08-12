// 10-quota-blocks-execution.mjs
//
// Sets an org's usage_calls == usage_limit (via admin secret, simulating
// "quota exhausted"), then confirms triggerWorkflowRun is rejected
// server-side even though the caller is a legitimate owner/editor.
import { assert, requireEnv, env, gqlAs } from "./lib.mjs";

const ADMIN_ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

async function adminGql(query, variables) {
  const res = await fetch(ADMIN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

export async function run() {
  console.log("Test 11: Quota blocks execution when exhausted");
  if (!requireEnv(["ownerAJwt", "orgAId", "workflowAId"])) return "skipped";
  if (!ADMIN_ENDPOINT || !ADMIN_SECRET) {
    console.log("  SKIPPED — HASURA_GRAPHQL_ADMIN_SECRET not set (needed to force-exhaust quota for this test)");
    return "skipped";
  }

  // Force usage_calls to equal usage_limit for Org A.
  await adminGql(
    `mutation($orgId: uuid!) {
      update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { usage_calls: 999999, usage_limit: 999999 }) { id }
    }`,
    { orgId: env.orgAId }
  );

  const result = await gqlAs(
    env.ownerAJwt,
    `mutation($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { workflow_run_id } }`,
    { id: env.workflowAId }
  );

  const blocked = result.errors?.length > 0 || result.data?.triggerWorkflowRun == null;
  assert(blocked, "triggerWorkflowRun is rejected once usage_calls >= usage_limit, even for the owner");

  // Restore a sane quota so the org is usable again for further demo runs.
  await adminGql(
    `mutation($orgId: uuid!) {
      update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { usage_calls: 0, usage_limit: 100 }) { id }
    }`,
    { orgId: env.orgAId }
  );

  return "passed";
}
