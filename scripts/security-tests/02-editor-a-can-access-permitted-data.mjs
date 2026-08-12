// 02-editor-a-can-access-permitted-data.mjs
import { gqlAs, assert, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 2: Org A editor can access permitted Org A data");
  if (!requireEnv(["editorAJwt", "orgAId"])) return "skipped";

  const result = await gqlAs(
    env.editorAJwt,
    `query($orgId: uuid!) { workflows(where: { org_id: { _eq: $orgId } }) { id name workflow_steps { id type } } }`,
    { orgId: env.orgAId }
  );

  assert(!result.errors, "no GraphQL errors for editor querying own org's workflows");
  assert(Array.isArray(result.data?.workflows), "editor receives workflow data for their own org");
  return "passed";
}
