// 06-editor-cannot-create-webhook-trigger.mjs
import { gqlAs, assertDenied, requireEnv, env } from "./lib.mjs";

export async function run() {
  console.log("Test 7: Editor cannot create a webhook trigger (raw GraphQL, bypassing UI)");
  if (!requireEnv(["editorAJwt", "workflowAId"])) return "skipped";

  const result = await gqlAs(
    env.editorAJwt,
    `mutation($workflowId: uuid!) {
      insert_workflow_triggers_one(
        object: { workflow_id: $workflowId, type: webhook, config: { secret: "hijack" } }
      ) { id }
    }`,
    { workflowId: env.workflowAId }
  );

  assertDenied(result, "editor's raw webhook-trigger insert mutation is rejected by Hasura permission check");
  return "passed";
}
