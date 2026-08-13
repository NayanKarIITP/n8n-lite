// lib/execution/engine.ts
//
// The execution engine is deliberately synchronous/in-process (invoked
// directly from the trigger-workflow-run and approve-step Action handlers,
// which run as Next.js serverless/Node functions). This is the simplest
// architecture that satisfies the assignment's requirements (persist every
// step_run to Postgres, pause on approval_gate, resume from approveStep) and
// keeps the demo debuggable end to end without extra infrastructure
// (queues, workers) that Nhost doesn't provide out of the box.
//
// Production note: for high step counts or long-running http_request calls
// you would move this onto a queue (e.g. a Postgres-backed job table polled
// by a worker, or Nhost's serverless functions triggered by pg_cron /
// Hasura scheduled triggers) so the Action handler returns immediately
// instead of holding an HTTP connection open. That refactor does not change
// the data model or the pause/resume contract below — see README "Known
// limitations".

import { adminGraphQL } from "@/lib/hasura";
import { callLLM } from "@/lib/llm";

export type StepType =
  | "llm_call"
  | "http_request"
  | "db_write"
  | "notify"
  | "conditional_branch"
  | "approval_gate";

export interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  position: number;
  type: StepType;
  config: Record<string, unknown>;
}

const RETRYABLE_TYPES: StepType[] = ["llm_call", "http_request"];
const MAX_ATTEMPTS = 2; // "at least one retry" => 2 total attempts

/**
 * Runs (or resumes) a workflow_run. When `resumeFromStepId` is provided,
 * steps before it are assumed already completed and execution starts at
 * that step (used by approveStep after an approval_gate).
 */
export async function runWorkflow(params: {
  workflowRunId: string;
  workflowId: string;
  resumeFromStepId?: string;
}): Promise<void> {
  const { workflowRunId, workflowId, resumeFromStepId } = params;

  const steps = await getOrderedSteps(workflowId);

  await setRunStatus(workflowRunId, "running", { started_at: !resumeFromStepId });

  // context threaded between steps: each step can read prior outputs by
  // step id, and llm_call output specifically is exposed as `lastLLMOutput`
  // for conditional_branch to consume, matching the assignment's demo
  // scenario (LLM output -> conditional branch -> different behavior).
  const context: {
    outputs: Record<string, unknown>;
    lastLLMOutput?: string;
    branchTaken?: "a" | "b";
  } = { outputs: {} };

  // If resuming, hydrate context from already-completed step_runs so
  // conditional_branch / downstream steps still see prior outputs.
  let startIndex = 0;
  if (resumeFromStepId) {
    const priorRuns = await getCompletedStepRunsForRun(workflowRunId);
    for (const run of priorRuns) {
      context.outputs[run.workflow_step_id] = run.output;
      const step = steps.find((s) => s.id === run.workflow_step_id);
      if (step?.type === "llm_call" && run.output && typeof run.output === "object") {
        context.lastLLMOutput = (run.output as Record<string, unknown>).text as string | undefined;
      }
    }
    // resumeFromStepId is the approval_gate step itself — execution must
    // continue with the NEXT step, not re-execute the gate (which would
    // unconditionally re-pause it, exactly the bug this comment documents:
    // observed in production as an approved step_run whose status flipped
    // back to "paused" immediately after approval, because the loop below
    // was starting at the gate's own index instead of index + 1).
    const gateIndex = steps.findIndex((s) => s.id === resumeFromStepId);
    startIndex = gateIndex === -1 ? 0 : gateIndex + 1;
  }

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];

    // conditional_branch can cause remaining steps to be skipped depending
    // on which branch was taken — see evaluateConditionalBranch below,
    // which mutates `skipRestUnless`.
    if (context.branchTaken && shouldSkipStep(step, context.branchTaken)) {
      await createSkippedStepRun(workflowRunId, step.id);
      continue;
    }

    const stepRunId = await createOrGetPendingStepRun(workflowRunId, step.id);

    try {
      const result = await executeStepWithRetry(step, context, stepRunId);

      if (result.paused) {
        // approval_gate: persist paused state and STOP. Do not continue.
        await setRunStatus(workflowRunId, "paused", {});
        return;
      }

      context.outputs[step.id] = result.output;
      if (step.type === "llm_call") {
        context.lastLLMOutput =
          result.output && typeof result.output === "object"
            ? (result.output as Record<string, unknown>).text as string
            : undefined;
      }
      if (step.type === "conditional_branch") {
        context.branchTaken = (result.output as { branch: "a" | "b" }).branch;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeStepRun(stepRunId, "failed", { error: message });
      await setRunStatus(workflowRunId, "failed", { completed_at: true, error: message });
      return;
    }
  }

  await setRunStatus(workflowRunId, "completed", { completed_at: true });
}

function shouldSkipStep(step: WorkflowStepRow, branchTaken: "a" | "b"): boolean {
  const branchOnly = step.config?.branch as "a" | "b" | undefined;
  return Boolean(branchOnly) && branchOnly !== branchTaken;
}

async function executeStepWithRetry(
  step: WorkflowStepRow,
  context: { lastLLMOutput?: string; outputs: Record<string, unknown> },
  stepRunId: string
): Promise<{ output: unknown; paused?: boolean }> {
  const maxAttempts = RETRYABLE_TYPES.includes(step.type) ? MAX_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await markStepRunRunning(stepRunId, attempt);
    try {
      const output = await executeStep(step, context, stepRunId);
      if ((output as { __paused?: boolean }).__paused) {
        return { output: null, paused: true };
      }
      await finalizeStepRun(stepRunId, "completed", { output });
      return { output };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function executeStep(
  step: WorkflowStepRow,
  context: { lastLLMOutput?: string; outputs: Record<string, unknown> },
  stepRunId: string
): Promise<unknown> {
  switch (step.type) {
    case "llm_call": {
      const prompt = (step.config?.prompt as string) || "Say hello.";
      const result = await callLLM(prompt);
      return { text: result.output, provider: result.provider, model: result.model };
    }

    case "http_request": {
      const method = ((step.config?.method as string) || "GET").toUpperCase();
      const url = step.config?.url as string;
      if (!url) throw new Error("http_request step missing config.url");
      const headers = (step.config?.headers as Record<string, string>) || {};
      const body = step.config?.body;

      const res = await fetch(url, {
        method,
        headers,
        body: body && method !== "GET" ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`http_request failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
      }
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave as text */
      }
      return { status: res.status, body: parsed };
    }

    case "conditional_branch": {
      const source = (step.config?.source as string) || "lastLLMOutput";
      const matchValue = ((step.config?.match as string) || "APPROVE").toUpperCase();
      const haystack = (source === "lastLLMOutput" ? context.lastLLMOutput : "") || "";
      const branch: "a" | "b" = haystack.toUpperCase().includes(matchValue) ? "a" : "b";
      return { branch, evaluatedAgainst: haystack };
    }

    case "approval_gate": {
      // Pause: persist step_run + workflow_run as paused, then signal the
      // caller to stop the loop. approveStep resumes from here later.
      await finalizeStepRun(stepRunId, "paused", { output: { message: "Awaiting approval" } });
      return { __paused: true };
    }

    case "db_write": {
      const key = (step.config?.key as string) || "result";
      const value = step.config?.value ?? context.outputs;
      const runInfo = await getStepRunParentIds(stepRunId);
      await adminGraphQL(
        `mutation($record: workflow_data_records_insert_input!) {
          insert_workflow_data_records_one(object: $record) { id }
        }`,
        {
          record: {
            org_id: runInfo.orgId,
            workflow_run_id: runInfo.workflowRunId,
            step_run_id: stepRunId,
            key,
            value,
          },
        }
      );
      return { written: true, key };
    }

    case "notify": {
      const runInfo = await getStepRunParentIds(stepRunId);
      const channel = (step.config?.channel as string) || "stub";
      const message = (step.config?.message as string) || "Workflow notification";
      // Event-driven: insert a row, let the Hasura Event Trigger deliver it.
      await adminGraphQL(
        `mutation($event: notification_events_insert_input!) {
          insert_notification_events_one(object: $event) { id }
        }`,
        {
          event: {
            org_id: runInfo.orgId,
            step_run_id: stepRunId,
            channel,
            payload: { message, context: context.outputs },
          },
        }
      );
      return { queued: true, channel };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers (all via admin GraphQL client)
// ---------------------------------------------------------------------------

async function getOrderedSteps(workflowId: string): Promise<WorkflowStepRow[]> {
  const data = await adminGraphQL<{ workflow_steps: WorkflowStepRow[] }>(
    `query($workflowId: uuid!) {
      workflow_steps(where: { workflow_id: { _eq: $workflowId } }, order_by: { position: asc }) {
        id workflow_id position type config
      }
    }`,
    { workflowId }
  );
  return data.workflow_steps;
}

async function getCompletedStepRunsForRun(
  workflowRunId: string
): Promise<{ workflow_step_id: string; output: unknown }[]> {
  const data = await adminGraphQL<{
    step_runs: { workflow_step_id: string; output: unknown }[];
  }>(
    `query($id: uuid!) {
      step_runs(where: { workflow_run_id: { _eq: $id }, status: { _eq: completed } }) {
        workflow_step_id output
      }
    }`,
    { id: workflowRunId }
  );
  return data.step_runs;
}

async function createOrGetPendingStepRun(workflowRunId: string, workflowStepId: string): Promise<string> {
  const existing = await adminGraphQL<{ step_runs: { id: string; status: string }[] }>(
    `query($runId: uuid!, $stepId: uuid!) {
      step_runs(where: { workflow_run_id: { _eq: $runId }, workflow_step_id: { _eq: $stepId } }, limit: 1) {
        id status
      }
    }`,
    { runId: workflowRunId, stepId: workflowStepId }
  );
  if (existing.step_runs[0]) return existing.step_runs[0].id;

  const created = await adminGraphQL<{ insert_step_runs_one: { id: string } }>(
    `mutation($object: step_runs_insert_input!) {
      insert_step_runs_one(object: $object) { id }
    }`,
    { object: { workflow_run_id: workflowRunId, workflow_step_id: workflowStepId, status: "pending" } }
  );
  return created.insert_step_runs_one.id;
}

async function createSkippedStepRun(workflowRunId: string, workflowStepId: string): Promise<void> {
  await adminGraphQL(
    `mutation($object: step_runs_insert_input!) {
      insert_step_runs_one(object: $object) { id }
    }`,
    {
      object: {
        workflow_run_id: workflowRunId,
        workflow_step_id: workflowStepId,
        status: "skipped",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
    }
  );
}

async function markStepRunRunning(stepRunId: string, attempt: number): Promise<void> {
  await adminGraphQL(
    `mutation($id: uuid!, $attempt: Int!, $now: timestamptz!) {
      update_step_runs_by_pk(
        pk_columns: { id: $id }
        _set: { status: running, attempt_count: $attempt, started_at: $now }
      ) { id }
    }`,
    { id: stepRunId, attempt, now: new Date().toISOString() }
  );
}

async function finalizeStepRun(
  stepRunId: string,
  status: "completed" | "failed" | "paused",
  fields: { output?: unknown; error?: string }
): Promise<void> {
  await adminGraphQL(
    `mutation($id: uuid!, $set: step_runs_set_input!) {
      update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: stepRunId,
      set: {
        status,
        output: fields.output ?? null,
        error: fields.error ?? null,
        completed_at: status !== "paused" ? new Date().toISOString() : null,
      },
    }
  );
}

async function getStepRunParentIds(
  stepRunId: string
): Promise<{ orgId: string; workflowRunId: string }> {
  const data = await adminGraphQL<{
    step_runs_by_pk: { workflow_run: { id: string; org_id: string } };
  }>(
    `query($id: uuid!) {
      step_runs_by_pk(id: $id) { workflow_run { id org_id } }
    }`,
    { id: stepRunId }
  );
  return {
    orgId: data.step_runs_by_pk.workflow_run.org_id,
    workflowRunId: data.step_runs_by_pk.workflow_run.id,
  };
}

async function setRunStatus(
  workflowRunId: string,
  status: "running" | "paused" | "completed" | "failed",
  opts: { started_at?: boolean; completed_at?: boolean; error?: string }
): Promise<void> {
  const set: Record<string, unknown> = { status };
  if (opts.started_at) set.started_at = new Date().toISOString();
  if (opts.completed_at) set.completed_at = new Date().toISOString();
  if (opts.error) set.error = opts.error;

  await adminGraphQL(
    `mutation($id: uuid!, $set: workflow_runs_set_input!) {
      update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id: workflowRunId, set }
  );
}