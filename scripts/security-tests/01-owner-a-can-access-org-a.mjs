// 01-owner-a-can-access-org-a.mjs
import { gqlAs, assert, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 1: Org A owner can access Org A");
  if (!requireEnv(["ownerAJwt", "orgAId"])) return "skipped";

  const result = await gqlAs(
    env.ownerAJwt,
    `query($orgId: uuid!) { workflows(where: { org_id: { _eq: $orgId } }) { id name } }`,
    { orgId: env.orgAId }
  );

  assert(!result.errors, "no GraphQL errors for owner querying own org's workflows");
  assert(Array.isArray(result.data?.workflows), "owner receives a workflows array for their own org");
  return "passed";
}
