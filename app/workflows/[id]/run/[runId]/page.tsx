"use client";

import { useSubscription, useMutation } from "@apollo/client";
import { WORKFLOW_RUN_STEP_RUNS_SUBSCRIPTION, APPROVE_STEP } from "@/lib/graphql/documents";

interface StepRun {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  workflow_step: { id: string; position: number; type: string };
  // GraphQL subscriptions may only select one top-level root field, so the
  // parent run's status is read via step_runs' own "workflow_run" object
  // relationship instead of a second top-level query — every step_run row
  // carries the same run info, we just read it off the first one.
  workflow_run: { id: string; status: string; started_at: string | null; completed_at: string | null; error: string | null };
}

export default function RunPage({ params }: { params: { id: string; runId: string } }) {
  const { data, loading, error } = useSubscription<{ step_runs: StepRun[] }>(
    WORKFLOW_RUN_STEP_RUNS_SUBSCRIPTION,
    { variables: { workflowRunId: params.runId } }
  );

  const [approveStep, { loading: approving }] = useMutation(APPROVE_STEP);

  if (loading && !data) return <div className="container">Connecting to live updates…</div>;
  if (error) return <div className="container">Subscription error: {error.message}</div>;

  const stepRuns = [...(data?.step_runs ?? [])].sort(
    (a, b) => a.workflow_step.position - b.workflow_step.position
  );
  const run = stepRuns[0]?.workflow_run ?? null;

  async function onApprove(stepRunId: string) {
    try {
      await approveStep({ variables: { step_run_id: stepRunId } });
    } catch (e: any) {
      alert("Approval failed: " + e.message);
    }
  }

  return (
    <div className="container">
      <h1>Run</h1>
      {run && (
        <div className="card">
          Status: <span className={`status-pill status-${run.status}`}>{run.status}</span>
          {run.error && <p style={{ color: "var(--err)" }}>{run.error}</p>}
        </div>
      )}
      {!run && stepRuns.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--muted)" }}>
            No step runs yet for this run ID — either it hasn&apos;t started, or you don&apos;t have access to it.
          </p>
        </div>
      )}

      {stepRuns.map((sr) => (
        <div key={sr.id} className="card">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>
              Step {sr.workflow_step.position + 1} · {sr.workflow_step.type}
            </strong>
            <span className={`status-pill status-${sr.status}`}>{sr.status}</span>
          </div>
          {sr.attempt_count > 1 && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>Attempts: {sr.attempt_count}</p>
          )}
          {sr.output != null && (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(sr.output, null, 2)}</pre>
          )}
          {sr.error && <p style={{ color: "var(--err)" }}>{sr.error}</p>}

          {sr.workflow_step.type === "approval_gate" && sr.status === "paused" && (
            <div>
              <p style={{ color: "var(--warn)" }}>Awaiting approval</p>
              <button className="btn" onClick={() => onApprove(sr.id)} disabled={approving}>
                {approving ? "Approving…" : "Approve"}
              </button>
              <p style={{ color: "var(--muted)", fontSize: 12 }}>
                The backend re-checks your organization role before resuming — viewers will be rejected even
                if this button is clicked.
              </p>
            </div>
          )}
          {sr.approved_by && (
            <p style={{ color: "var(--muted)", fontSize: 12 }}>
              Approved by {sr.approved_by} at {sr.approved_at}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}