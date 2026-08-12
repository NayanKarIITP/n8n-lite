// app/api/actions/trigger-workflow-run/route.ts
//
// Hasura Action handler for `triggerWorkflowRun(workflow_id: uuid!)`.
// Full authorization + quota + execution flow as required by the
// assignment. Runs synchronously (see lib/execution/engine.ts header note
// on why) and returns once execution reaches completion, failure, or a
// paused approval_gate.

import { NextRequest } from "next/server";
import { assertActionSecret, getCallerUserId, ActionRequestBody, UnauthorizedError } from "@/lib/actionAuth";
import { adminGraphQL, getCallerRoleForWorkflow } from "@/lib/hasura";
import { runWorkflow } from "@/lib/execution/engine";

interface Input {
  workflow_id: string;
}

export async function POST(req: NextRequest) {
  try {
    assertActionSecret(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ message: e.message }, { status: 401 });
    throw e;
  }

  const body = (await req.json()) as ActionRequestBody<Input>;

  let userId: string;
  try {
    userId = getCallerUserId(body);
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ message: e.message }, { status: 401 });
    throw e;
  }

  const { workflow_id } = body.input;
  if (!workflow_id) {
    return Response.json({ message: "workflow_id is required" }, { status: 400 });
  }

  // --- Layer 1: org membership + role, re-derived server-side ------------
  const membership = await getCallerRoleForWorkflow(userId, workflow_id);
  if (!membership) {
    // Deliberately identical response whether the workflow doesn't exist
    // or the caller isn't a member — do not leak cross-org existence.
    return Response.json({ message: "Workflow not found" }, { status: 404 });
  }
  if (membership.role !== "owner" && membership.role !== "editor") {
    return Response.json({ message: "Viewers cannot trigger workflow runs" }, { status: 403 });
  }

  // --- Quota: atomic check-and-increment, race-safe ------------------------
  const quota = await adminGraphQL<{
    try_consume_org_quota: { id: string; usage_calls: number; usage_limit: number }[];
  }>(
    `mutation($orgId: uuid!) {
      try_consume_org_quota(args: { p_org_id: $orgId, p_amount: 1 }) {
        id usage_calls usage_limit
      }
    }`,
    { orgId: membership.orgId }
  );

  if (!quota.try_consume_org_quota[0]) {
    return Response.json(
      { message: "Organization usage quota exceeded. Increase usage_limit or wait for the next period." },
      { status: 429 }
    );
  }

  // --- Create workflow_run -------------------------------------------------
  const created = await adminGraphQL<{ insert_workflow_runs_one: { id: string } }>(
    `mutation($object: workflow_runs_insert_input!) {
      insert_workflow_runs_one(object: $object) { id }
    }`,
    {
      object: {
        workflow_id,
        org_id: membership.orgId,
        status: "pending",
        trigger_type: "manual",
        triggered_by: userId,
      },
    }
  );
  const workflowRunId = created.insert_workflow_runs_one.id;

  // --- Execute ---------------------------------------------------------------
  try {
    await runWorkflow({ workflowRunId, workflowId: workflow_id });
  } catch (err) {
    // runWorkflow already persists failure state internally; this catch is
    // a last-resort safety net so the Action always returns a clean
    // response instead of a 500 with a stuck "running" row.
    console.error("runWorkflow crashed:", err);
  }

  const final = await adminGraphQL<{ workflow_runs_by_pk: { status: string } }>(
    `query($id: uuid!) { workflow_runs_by_pk(id: $id) { status } }`,
    { id: workflowRunId }
  );

  return Response.json({
    workflow_run_id: workflowRunId,
    status: final.workflow_runs_by_pk.status,
  });
}
