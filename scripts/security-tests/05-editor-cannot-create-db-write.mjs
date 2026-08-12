// 05-editor-cannot-create-db-write.mjs
//
// LAYER 2 TEST: even though editor CAN create workflow_steps in general,
// db_write specifically must be rejected — enforced in Hasura's insert
// `check` expression (public_workflow_steps.yaml), not merely hidden in
// the UI. This script bypasses the UI entirely.
import { gqlAs, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 6: Editor cannot create a db_write step (raw GraphQL, bypassing UI)");
  if (!requireEnv(["editorAJwt", "workflowAId"])) return "skipped";

  const result = await gqlAs(
    env.editorAJwt,
    `mutation($workflowId: uuid!) {
      insert_workflow_steps_one(
        object: { workflow_id: $workflowId, position: 99, type: db_write, config: {} }
      ) { id }
    }`,
    { workflowId: env.workflowAId }
  );

  assertDenied(result, "editor's raw db_write insert mutation is rejected by Hasura permission check");
  return "passed";
}
