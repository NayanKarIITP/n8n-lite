// 04-cross-org-isolation.mjs
import { gqlAs, assert, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 4/5: Cross-org isolation (Org A cannot access Org B and vice versa)");
  if (!requireEnv(["ownerAJwt", "ownerBJwt", "orgAId", "orgBId", "workflowAId"])) return "skipped";

  // Org A owner tries to read Org B's workflows by supplying Org B's id directly.
  const aReadsB = await gqlAs(
    env.ownerAJwt,
    `query($orgId: uuid!) { workflows(where: { org_id: { _eq: $orgId } }) { id name } }`,
    { orgId: env.orgBId }
  );
  assert(
    (aReadsB.data?.workflows ?? []).length === 0,
    "Org A owner querying with Org B's org_id gets zero rows (row filter ignores client-supplied org_id)"
  );

  // Org B owner tries to trigger Org A's workflow by ID.
  const bTriggersA = await gqlAs(
    env.ownerBJwt,
    `mutation($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { workflow_run_id } }`,
    { id: env.workflowAId }
  );
  assertDenied(bTriggersA, "Org B owner cannot trigger Org A's workflow by guessing its ID (404/not found)");

  // Org B owner tries to read Org A's workflow directly by primary key.
  const bReadsAByPk = await gqlAs(
    env.ownerBJwt,
    `query($id: uuid!) { workflows_by_pk(id: $id) { id name } }`,
    { id: env.workflowAId }
  );
  assert(
    bReadsAByPk.data?.workflows_by_pk === null,
    "Org B owner gets null reading Org A's workflow by primary key (row filter still applies to _by_pk)"
  );

  return "passed";
}
