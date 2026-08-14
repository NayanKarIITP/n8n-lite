"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@apollo/client";
import { useAuthenticationStatus, useSignOut, useUserId } from "@nhost/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  MY_ORGS,
  ORG_WORKFLOWS_DETAILED,
  CREATE_WORKFLOW,
  CREATE_INVITATION,
  MY_ORG_INVITATIONS,
} from "@/lib/graphql/documents";

interface OrgMembership {
  id: string;
  role: "owner" | "editor" | "viewer";
  organization: { id: string; name: string; usage_calls: number; usage_limit: number };
}

export default function DashboardPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();
  const userId = useUserId();
  const { signOut } = useSignOut();
  const router = useRouter();

  const { data: orgsData, loading: orgsLoading } = useQuery<{ org_members: OrgMembership[] }>(MY_ORGS, {
    skip: !isAuthenticated,
  });

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [newWorkflowName, setNewWorkflowName] = useState("");

  const memberships = orgsData?.org_members ?? [];
  const activeOrgId = selectedOrgId || memberships[0]?.organization.id || null;
  const activeMembership = memberships.find((m) => m.organization.id === activeOrgId);

  const { data: wfData, loading: wfLoading, refetch } = useQuery(ORG_WORKFLOWS_DETAILED, {
    variables: { orgId: activeOrgId },
    skip: !activeOrgId,
  });

  const [createWorkflow, { loading: creating }] = useMutation(CREATE_WORKFLOW);

  if (authLoading) return <div className="container">Loading…</div>;
  if (!isAuthenticated) {
    router.replace("/auth/sign-in");
    return null;
  }

  const canEdit = activeMembership?.role === "owner" || activeMembership?.role === "editor";
  const isOwner = activeMembership?.role === "owner";

  async function onCreateWorkflow(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !newWorkflowName.trim()) return;
    await createWorkflow({ variables: { org_id: activeOrgId, name: newWorkflowName, description: "" } });
    setNewWorkflowName("");
    refetch();
  }

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>n8n-lite</h1>
        <button className="btn btn-secondary" onClick={() => signOut()}>
          Sign out
        </button>
      </div>

      {orgsLoading && <p>Loading organizations…</p>}
      {!orgsLoading && memberships.length === 0 && (
        <p className="card">
          You are not a member of any organization yet. Ask an owner to invite you (see &quot;Invite member&quot;
          below), or ask them to add user_id <code>{userId}</code> to <code>org_members</code> directly.
        </p>
      )}

      {memberships.length > 0 && (
        <div className="card">
          <label>Organization</label>
          <select value={activeOrgId ?? ""} onChange={(e) => setSelectedOrgId(e.target.value)}>
            {memberships.map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.name} — {m.role}
              </option>
            ))}
          </select>
          {activeMembership && (
            <p style={{ color: "var(--muted)", marginTop: 8 }}>
              Usage this period: {activeMembership.organization.usage_calls} /{" "}
              {activeMembership.organization.usage_limit}
            </p>
          )}
        </div>
      )}

      {activeOrgId && isOwner && <MemberInvitePanel orgId={activeOrgId} />}

      {activeOrgId && (
        <>
          {canEdit && (
            <form onSubmit={onCreateWorkflow} className="card" style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="New workflow name"
                value={newWorkflowName}
                onChange={(e) => setNewWorkflowName(e.target.value)}
              />
              <button className="btn" disabled={creating} type="submit">
                Create workflow
              </button>
            </form>
          )}
          {!canEdit && (
            <p style={{ color: "var(--muted)" }}>
              You are a viewer in this organization — you can read workflows but cannot create, edit, or
              trigger them.
            </p>
          )}

          {wfLoading && <p>Loading workflows…</p>}
          {wfData?.workflows?.map((wf: any) => {
            const lastRun = wf.workflow_runs[0];
            return (
              <div key={wf.id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <strong>{wf.name}</strong>
                    <p style={{ color: "var(--muted)", margin: "4px 0" }}>{wf.description}</p>
                    <p style={{ fontSize: 13, color: "var(--muted)" }}>
                      {wf.workflow_steps.length} steps · {wf.workflow_triggers.length} triggers
                      {wf.run_stats?.avg_duration_seconds
                        ? ` · avg run ${Math.round(wf.run_stats.avg_duration_seconds)}s`
                        : ""}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {lastRun && <span className={`status-pill status-${lastRun.status}`}>{lastRun.status}</span>}
                    <div style={{ marginTop: 8 }}>
                      <Link href={`/workflows/${wf.id}/builder`}>Open builder</Link>
                      {lastRun && (
                        <>
                          {" · "}
                          <Link href={`/workflows/${wf.id}/run/${lastRun.id}`}>Last run</Link>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// Owner-only: create an invitation (normal Hasura insert mutation, no
// admin secret — enforced by the org_invitations owner-only insert
// permission) and list pending/accepted invites for this org. The
// invite link itself must be shared by the owner through any channel
// (this app does not send email — same documented stub philosophy as
// the `notify` step); accepting it goes through the acceptInvitation
// Action, which independently verifies the invitee's real email.
function MemberInvitePanel({ orgId }: { orgId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "editor" | "viewer">("viewer");
  const [createInvitation, { loading: inviting, error: inviteError }] = useMutation(CREATE_INVITATION);
  const { data, loading, refetch } = useQuery(MY_ORG_INVITATIONS, { variables: { orgId } });

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    await createInvitation({ variables: { org_id: orgId, email: email.trim(), role } });
    setEmail("");
    refetch();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="card">
      <strong>Invite member</strong>
      <form onSubmit={onInvite} style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <input
          placeholder="invitee@email.com"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
          <option value="owner">owner</option>
        </select>
        <button className="btn" disabled={inviting} type="submit">
          {inviting ? "Inviting…" : "Send invite"}
        </button>
      </form>
      {inviteError && <p style={{ color: "var(--err)", fontSize: 13 }}>{inviteError.message}</p>}

      {loading && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading invitations…</p>}
      {data?.org_invitations?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {data.org_invitations.map((inv: any) => (
            <div key={inv.id} style={{ fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <span style={{ color: "var(--muted)" }}>{inv.email}</span> — {inv.role} —{" "}
              <span className={`status-pill status-${inv.status === "accepted" ? "completed" : "pending"}`}>
                {inv.status}
              </span>
              {inv.status === "pending" && origin && (
                <div style={{ marginTop: 4 }}>
                  <code style={{ fontSize: 11, wordBreak: "break-all" }}>
                    {origin}/invite/{inv.token}
                  </code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
