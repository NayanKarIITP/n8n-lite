// 07-editor-cannot-create-notify.mjs
import { gqlAs, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 8: Editor cannot create a notify step (raw GraphQL, bypassing UI)");
  if (!requireEnv(["editorAJwt", "workflowAId"])) return "skipped";

  const result = await gqlAs(
    env.editorAJwt,
    `mutation($workflowId: uuid!) {
      insert_workflow_steps_one(
        object: { workflow_id: $workflowId, position: 98, type: notify, config: {} }
      ) { id }
    }`,
    { workflowId: env.workflowAId }
  );

  assertDenied(result, "editor's raw notify insert mutation is rejected by Hasura permission check");
  return "passed";
}
