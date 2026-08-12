"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@apollo/client";
import { useUserId } from "@nhost/react";
import { useRouter } from "next/navigation";
import {
  WORKFLOW_BUILDER_QUERY,
  CREATE_STEP,
  UPDATE_STEP,
  DELETE_STEP,
  CREATE_TRIGGER,
  TRIGGER_WORKFLOW_RUN,
} from "@/lib/graphql/documents";

const STEP_TYPES = [
  { value: "llm_call", label: "LLM call", ownerOnly: false },
  { value: "http_request", label: "HTTP request", ownerOnly: false },
  { value: "conditional_branch", label: "Conditional branch", ownerOnly: false },
  { value: "approval_gate", label: "Approval gate", ownerOnly: false },
  { value: "db_write", label: "DB write (owner only)", ownerOnly: true },
  { value: "notify", label: "Notify (owner only)", ownerOnly: true },
] as const;

export default function WorkflowBuilderPage({ params }: { params: { id: string } }) {
  const workflowId = params.id;
  const userId = useUserId();
  const router = useRouter();

  const { data, loading, refetch } = useQuery(WORKFLOW_BUILDER_QUERY, { variables: { id: workflowId } });
  const [createStep] = useMutation(CREATE_STEP);
  const [updateStep] = useMutation(UPDATE_STEP);
  const [deleteStep] = useMutation(DELETE_STEP);
  const [createTrigger] = useMutation(CREATE_TRIGGER);
  const [triggerRun, { loading: triggering }] = useMutation(TRIGGER_WORKFLOW_RUN);

  const [newStepType, setNewStepType] = useState<string>("llm_call");
  const [runError, setRunError] = useState<string | null>(null);

  if (loading) return <div className="container">Loading…</div>;

  const workflow = data?.workflows_by_pk;
  if (!workflow) {
    return (
      <div className="container">
        <p>Workflow not found (or you do not have access to it).</p>
      </div>
    );
  }

  const myRole = workflow.organization.org_members.find((m: any) => m.user_id === userId)?.role as
    | "owner"
    | "editor"
    | "viewer"
    | undefined;

  const canEdit = myRole === "owner" || myRole === "editor";
  const isOwner = myRole === "owner";
  const canRun = myRole === "owner" || myRole === "editor";

  const steps = workflow.workflow_steps;
  const webhookTrigger = workflow.workflow_triggers.find((t: any) => t.type === "webhook");

  async function addStep() {
    const meta = STEP_TYPES.find((t) => t.value === newStepType)!;
    if (meta.ownerOnly && !isOwner) return; // UI guard; server also enforces this
    const position = steps.length;
    const defaultConfig = defaultConfigFor(newStepType);
    try {
      await createStep({
        variables: { workflow_id: workflowId, position, type: newStepType, config: defaultConfig },
      });
      refetch();
    } catch (e: any) {
      alert("Could not add step: " + e.message + "\n(This is expected if the backend correctly rejected a restricted step type for your role.)");
    }
  }

  async function removeStep(id: string) {
    await deleteStep({ variables: { id } });
    refetch();
  }

  async function moveStep(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const a = steps[index];
    const b = steps[target];
    await updateStep({ variables: { id: a.id, position: b.position } });
    await updateStep({ variables: { id: b.id, position: a.position } });
    refetch();
  }

  async function saveStepConfig(id: string, config: unknown) {
    await updateStep({ variables: { id, config } });
    refetch();
  }

  async function addWebhookTrigger() {
    if (!isOwner) return;
    const secret = crypto.randomUUID();
    await createTrigger({
      variables: { workflow_id: workflowId, type: "webhook", config: { secret } },
    });
    refetch();
  }

  async function addManualTrigger() {
    await createTrigger({ variables: { workflow_id: workflowId, type: "manual", config: {} } });
    refetch();
  }

  async function onRun() {
    setRunError(null);
    try {
      const res = await triggerRun({ variables: { workflow_id: workflowId } });
      const runId = res.data?.triggerWorkflowRun?.workflow_run_id;
      if (runId) router.push(`/workflows/${workflowId}/run/${runId}`);
    } catch (e: any) {
      setRunError(e.message);
    }
  }

  return (
    <div className="container">
      <h1>{workflow.name}</h1>
      <p style={{ color: "var(--muted)" }}>Your role in this org: {myRole ?? "unknown"}</p>

      <div className="card">
        <strong>Steps</strong>
        {steps.map((step: any, i: number) => (
          <StepEditor
            key={step.id}
            step={step}
            index={i}
            total={steps.length}
            canEdit={canEdit}
            isOwner={isOwner}
            onMove={moveStep}
            onRemove={removeStep}
            onSave={saveStepConfig}
          />
        ))}

        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <select value={newStepType} onChange={(e) => setNewStepType(e.target.value)}>
              {STEP_TYPES.map((t) => (
                <option key={t.value} value={t.value} disabled={t.ownerOnly && !isOwner}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className="btn" onClick={addStep}>
              Add step
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <strong>Triggers</strong>
        <ul>
          {workflow.workflow_triggers.map((t: any) => (
            <li key={t.id}>
              {t.type} {t.type === "webhook" && t.config?.secret && (
                <code style={{ fontSize: 12 }}>
                  POST /api/webhooks/trigger/{workflowId}?secret={t.config.secret}
                </code>
              )}
            </li>
          ))}
        </ul>
        {canEdit && !workflow.workflow_triggers.some((t: any) => t.type === "manual") && (
          <button className="btn btn-secondary" onClick={addManualTrigger}>
            Add manual trigger
          </button>
        )}
        {isOwner && !webhookTrigger && (
          <button className="btn btn-secondary" onClick={addWebhookTrigger} style={{ marginLeft: 8 }}>
            Add webhook trigger (owner only)
          </button>
        )}
        {!isOwner && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Only an owner can add a webhook trigger.
          </p>
        )}
      </div>

      <div className="card">
        {canRun ? (
          <button className="btn" onClick={onRun} disabled={triggering}>
            {triggering ? "Starting…" : "Run"}
          </button>
        ) : (
          <p style={{ color: "var(--muted)" }}>Viewers cannot trigger workflow runs.</p>
        )}
        {runError && <p style={{ color: "var(--err)" }}>{runError}</p>}
      </div>
    </div>
  );
}

function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "llm_call":
      return { prompt: "Does this request meet our approval criteria? Reply APPROVE or REJECT with reasoning." };
    case "http_request":
      return { method: "GET", url: "https://httpbin.org/get", headers: {}, body: null };
    case "conditional_branch":
      return { source: "lastLLMOutput", match: "APPROVE" };
    case "approval_gate":
      return {};
    case "db_write":
      return { key: "result", value: null };
    case "notify":
      return { channel: "stub", message: "Workflow reached a notify step" };
    default:
      return {};
  }
}

function StepEditor({
  step,
  index,
  total,
  canEdit,
  isOwner,
  onMove,
  onRemove,
  onSave,
}: {
  step: any;
  index: number;
  total: number;
  canEdit: boolean;
  isOwner: boolean;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onSave: (id: string, config: unknown) => void;
}) {
  const [configText, setConfigText] = useState(JSON.stringify(step.config, null, 2));
  const restricted = step.type === "db_write" || step.type === "notify";

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>
          {index + 1}. {step.type} {restricted && <span style={{ color: "var(--warn)" }}>(owner-only)</span>}
        </strong>
        {canEdit && (
          <div>
            <button className="btn-secondary btn" onClick={() => onMove(index, -1)} disabled={index === 0}>
              ↑
            </button>
            <button
              className="btn-secondary btn"
              onClick={() => onMove(index, 1)}
              disabled={index === total - 1}
              style={{ marginLeft: 4 }}
            >
              ↓
            </button>
            <button className="btn-secondary btn" onClick={() => onRemove(step.id)} style={{ marginLeft: 4 }}>
              Remove
            </button>
          </div>
        )}
      </div>
      <textarea
        rows={4}
        style={{ marginTop: 6, fontFamily: "monospace", fontSize: 12 }}
        value={configText}
        onChange={(e) => setConfigText(e.target.value)}
        disabled={!canEdit || (restricted && !isOwner)}
      />
      {canEdit && (
        <button
          className="btn btn-secondary"
          style={{ marginTop: 6 }}
          onClick={() => {
            try {
              onSave(step.id, JSON.parse(configText));
            } catch {
              alert("Invalid JSON");
            }
          }}
        >
          Save config
        </button>
      )}
    </div>
  );
}
