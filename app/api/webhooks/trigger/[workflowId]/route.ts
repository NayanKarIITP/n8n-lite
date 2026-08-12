// app/api/webhooks/trigger/[workflowId]/route.ts
//
// The required "second trigger besides manual". An external system (curl,
// Postman, a real webhook sender) POSTs here to start a run without anyone
// clicking "Run" in the UI.
//
// Auth model for this route is necessarily different from the Action
// handlers: there is no logged-in user, so we authorize using a per-trigger
// secret stored in workflow_triggers.config.secret (set when the trigger
// was created — creation of a `webhook` trigger is itself owner-restricted,
// enforced by Hasura permissions, so only an owner can mint this secret in
// the first place). The request must supply it as `?secret=...` or header
// `x-webhook-secret`. No secret match => no run, regardless of workflow_id
// guessing — this preserves the "cannot access Org B by guessing IDs"
// property for the webhook path too.
//
// Quota is still enforced atomically via try_consume_org_quota, and
// trigger_type is recorded as "webhook" on the resulting workflow_run so
// the UI can show which trigger started it.

import { NextRequest } from "next/server";
import { adminGraphQL } from "@/lib/hasura";
import { runWorkflow } from "@/lib/execution/engine";

export async function POST(req: NextRequest, { params }: { params: { workflowId: string } }) {
  const workflowId = params.workflowId;
  const url = new URL(req.url);
  const suppliedSecret = url.searchParams.get("secret") || req.headers.get("x-webhook-secret");

  if (!suppliedSecret) {
    return Response.json({ message: "Missing webhook secret" }, { status: 401 });
  }

  const triggerLookup = await adminGraphQL<{
    workflow_triggers: {
      id: string;
      enabled: boolean;
      config: { secret?: string };
      workflow: { id: string; org_id: string };
    }[];
  }>(
    `query($workflowId: uuid!) {
      workflow_triggers(where: { workflow_id: { _eq: $workflowId }, type: { _eq: webhook } }) {
        id enabled config workflow { id org_id }
      }
    }`,
    { workflowId }
  );

  const trigger = triggerLookup.workflow_triggers.find((t) => t.config?.secret === suppliedSecret);

  if (!trigger || !trigger.enabled) {
    // Same response whether the workflow/trigger doesn't exist or the
    // secret is wrong — do not leak which is the case.
    return Response.json({ message: "Not found or trigger disabled" }, { status: 404 });
  }

  const quota = await adminGraphQL<{
    try_consume_org_quota: { id: string }[];
  }>(
    `mutation($orgId: uuid!) {
      try_consume_org_quota(args: { p_org_id: $orgId, p_amount: 1 }) { id }
    }`,
    { orgId: trigger.workflow.org_id }
  );

  if (!quota.try_consume_org_quota[0]) {
    return Response.json({ message: "Organization usage quota exceeded" }, { status: 429 });
  }

  const created = await adminGraphQL<{ insert_workflow_runs_one: { id: string } }>(
    `mutation($object: workflow_runs_insert_input!) {
      insert_workflow_runs_one(object: $object) { id }
    }`,
    {
      object: {
        workflow_id: workflowId,
        org_id: trigger.workflow.org_id,
        status: "pending",
        trigger_type: "webhook",
        triggered_by: null,
      },
    }
  );
  const workflowRunId = created.insert_workflow_runs_one.id;

  try {
    await runWorkflow({ workflowRunId, workflowId });
  } catch (err) {
    console.error("runWorkflow (webhook) crashed:", err);
  }

  return Response.json({ workflow_run_id: workflowRunId }, { status: 202 });
}
