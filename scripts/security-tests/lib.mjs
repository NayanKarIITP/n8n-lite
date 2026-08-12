// scripts/security-tests/lib.mjs
//
// Minimal GraphQL client for the security test scripts. These scripts talk
// directly to the Hasura GraphQL endpoint using per-user JWTs (NOT the
// admin secret) so they exercise the exact same permission path a real
// browser client would — this is "test GraphQL/backend behavior directly"
// as the assignment requires, not a UI test.
//
// Requires a running Hasura endpoint + real signed-in test users. See
// README "Database security testing" for how to seed the six demo users
// (Owner A/Editor A/Viewer A/Owner B/Editor B/Viewer B) and obtain their
// JWTs before running these.

const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT;

export async function gqlAs(jwt, query, variables = {}) {
  if (!ENDPOINT) {
    throw new Error("HASURA_GRAPHQL_ENDPOINT is not set — see README before running security tests");
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  return { httpStatus: res.status, ...json };
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error("ASSERTION FAILED: " + message);
  }
  console.log("  \x1b[32m✓\x1b[0m " + message);
}

export function assertDenied(result, message) {
  const denied =
    (result.errors && result.errors.length > 0) ||
    result.data === null ||
    (result.data &&
      Object.values(result.data).every((v) => v === null || (Array.isArray(v) && v.length === 0)));
  assert(denied, message);
}

export const env = {
  // Fill these in from your seeded demo users (README "Demo users").
  ownerAJwt: process.env.TEST_OWNER_A_JWT,
  editorAJwt: process.env.TEST_EDITOR_A_JWT,
  viewerAJwt: process.env.TEST_VIEWER_A_JWT,
  ownerBJwt: process.env.TEST_OWNER_B_JWT,
  editorBJwt: process.env.TEST_EDITOR_B_JWT,
  viewerBJwt: process.env.TEST_VIEWER_B_JWT,
  orgAId: process.env.TEST_ORG_A_ID,
  orgBId: process.env.TEST_ORG_B_ID,
  workflowAId: process.env.TEST_WORKFLOW_A_ID,
  stepRunApprovalGateId: process.env.TEST_APPROVAL_STEP_RUN_ID,
};

export function requireEnv(names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.log(
      `  \x1b[33mSKIPPED\x1b[0m — missing env vars for: ${missing.join(", ")}. ` +
        `See README "Database security testing" to seed test data and export these.`
    );
    return false;
  }
  return true;
}
