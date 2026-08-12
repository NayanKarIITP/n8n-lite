// app/api/actions/approve-step/route.ts
//
// Hasura Action handler for `approveStep(step_run_id: uuid!)`.
// Re-derives the workflow's organization from step_run_id itself (never
// trusts a client-supplied org/workflow id), checks the caller's role,
// validates the step is actually an approval_gate that is actually paused,
// records approved_by/approved_at, and resumes execution.

import { NextRequest } from "next/server";
import { assertActionSecret, getCallerUserId, ActionRequestBody, UnauthorizedError } from "@/lib/actionAuth";
import { adminGraphQL } from "@/lib/hasura";
import { runWorkflow } from "@/lib/execution/engine";

interface Input {
  step_run_id: string;
}

interface StepRunLookup {
  step_runs_by_pk: {
    id: string;
    status: string;
    workflow_run: {
      id: string;
      status: string;
      workflow_id: string;
      org_id: string;
    };
    workflow_step: {
      id: string;
      type: string;
    };
  } | null;
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

  const { step_run_id } = body.input;
  if (!step_run_id) {
    return Response.json({ message: "step_run_id is required" }, { status: 400 });
  }

  // --- Resolve step_run -> workflow_run -> workflow -> org, from the DB ---
  // (never from client input) -------------------------------------------
  const lookup = await adminGraphQL<StepRunLookup>(
    `query($id: uuid!) {
      step_runs_by_pk(id: $id) {
        id
        status
        workflow_run { id status workflow_id org_id }
        workflow_step { id type }
      }
    }`,
    { id: step_run_id }
  );

  const stepRun = lookup.step_runs_by_pk;
  if (!stepRun) {
    return Response.json({ message: "Step run not found" }, { status: 404 });
  }

  // --- Validity checks -----------------------------------------------------
  if (stepRun.workflow_step.type !== "approval_gate") {
    return Response.json({ message: "This step is not an approval gate" }, { status: 400 });
  }
  if (stepRun.status !== "paused") {
    return Response.json(
      { message: `Step is not awaiting approval (current status: ${stepRun.status})` },
      { status: 409 }
    );
  }
  if (stepRun.workflow_run.status !== "paused") {
    return Response.json(
      { message: `Workflow run is not paused (current status: ${stepRun.workflow_run.status})` },
      { status: 409 }
    );
  }

  // --- Layer 1: org membership + role, re-derived server-side -------------
  const member = await adminGraphQL<{ org_members: { role: "owner" | "editor" | "viewer" }[] }>(
    `query($orgId: uuid!, $userId: uuid!) {
      org_members(where: { org_id: { _eq: $orgId }, user_id: { _eq: $userId } }, limit: 1) { role }
    }`,
    { orgId: stepRun.workflow_run.org_id, userId }
  );
  const role = member.org_members[0]?.role;

  if (!role) {
    // Not a member of this org at all — includes cross-org guessing attempts.
    return Response.json({ message: "Step run not found" }, { status: 404 });
  }
  if (role !== "owner" && role !== "editor") {
    return Response.json({ message: "Viewers cannot approve workflow steps" }, { status: 403 });
  }

  // --- Record approval -------------------------------------------------------
  await adminGraphQL(
    `mutation($id: uuid!, $userId: uuid!, $now: timestamptz!) {
      update_step_runs_by_pk(
        pk_columns: { id: $id }
        _set: { approved_by: $userId, approved_at: $now, status: completed, completed_at: $now }
      ) { id }
    }`,
    { id: step_run_id, userId, now: new Date().toISOString() }
  );

  // --- Resume execution --------------------------------------------------------
  try {
    await runWorkflow({
      workflowRunId: stepRun.workflow_run.id,
      workflowId: stepRun.workflow_run.workflow_id,
      resumeFromStepId: stepRun.workflow_step.id,
    });
  } catch (err) {
    console.error("runWorkflow (resume) crashed:", err);
  }

  const final = await adminGraphQL<{ workflow_runs_by_pk: { status: string } }>(
    `query($id: uuid!) { workflow_runs_by_pk(id: $id) { status } }`,
    { id: stepRun.workflow_run.id }
  );

  return Response.json({
    step_run_id,
    workflow_run_id: stepRun.workflow_run.id,
    status: final.workflow_runs_by_pk.status,
  });
}
