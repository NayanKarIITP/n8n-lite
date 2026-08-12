// lib/hasura.ts
//
// Server-only admin GraphQL client. Used exclusively inside
// app/api/actions/*, app/api/webhooks/*, and lib/execution/* — never
// imported from client components. Because it carries the admin secret it
// bypasses all row-level permissions, so every call site MUST have already
// performed its own authorization check using org_members before calling
// this.
//
// Env vars: Nhost projects expose NHOST_GRAPHQL_URL / NHOST_ADMIN_SECRET as
// system-provided environment variables, so those are used first. The
// HASURA_GRAPHQL_ENDPOINT / HASURA_GRAPHQL_ADMIN_SECRET names remain as a
// fallback for a self-hosted Hasura instance not managed by Nhost, or for
// local overrides. There is no direct PostgreSQL connection used anywhere
// in this file, or anywhere else in the app — every read/write goes
// through Hasura's GraphQL/admin API.

const HASURA_GRAPHQL_ENDPOINT = process.env.NHOST_GRAPHQL_URL || process.env.HASURA_GRAPHQL_ENDPOINT;
const HASURA_GRAPHQL_ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET;

if (typeof window !== "undefined") {
  throw new Error("lib/hasura.ts must never be imported into client-side code");
}

export class HasuraError extends Error {
  constructor(public errors: unknown) {
    super("Hasura GraphQL error: " + JSON.stringify(errors));
  }
}

export async function adminGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  if (!HASURA_GRAPHQL_ENDPOINT || !HASURA_GRAPHQL_ADMIN_SECRET) {
    throw new Error(
      "NHOST_GRAPHQL_URL / NHOST_ADMIN_SECRET (or HASURA_GRAPHQL_ENDPOINT / HASURA_GRAPHQL_ADMIN_SECRET) " +
        "are not set. See README Environment Variables."
    );
  }

  const res = await fetch(HASURA_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": HASURA_GRAPHQL_ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as { data?: T; errors?: unknown };

  if (json.errors) {
    throw new HasuraError(json.errors);
  }

  return json.data as T;
}

/**
 * Verifies that `userId` is a member of the organization that owns
 * `workflowId`, and returns their role. Returns null if not a member
 * (which the caller must treat as "not found" — do not distinguish
 * "workflow doesn't exist" from "you can't see it", to avoid leaking
 * cross-org existence via error messages).
 */
export async function getCallerRoleForWorkflow(
  userId: string,
  workflowId: string
): Promise<{ orgId: string; role: "owner" | "editor" | "viewer" } | null> {
  const data = await adminGraphQL<{
    workflows_by_pk: { org_id: string } | null;
  }>(
    `query($workflowId: uuid!) {
      workflows_by_pk(id: $workflowId) { org_id }
    }`,
    { workflowId }
  );

  const orgId = data.workflows_by_pk?.org_id;
  if (!orgId) return null;

  const member = await adminGraphQL<{
    org_members: { role: "owner" | "editor" | "viewer" }[];
  }>(
    `query($orgId: uuid!, $userId: uuid!) {
      org_members(where: { org_id: { _eq: $orgId }, user_id: { _eq: $userId } }, limit: 1) {
        role
      }
    }`,
    { orgId, userId }
  );

  const role = member.org_members[0]?.role;
  if (!role) return null;

  return { orgId, role };
}

/**
 * Same as above, but resolves the organization starting from a
 * workflow_run id (used by approveStep, which only receives step_run_id).
 */
export async function getCallerRoleForWorkflowRun(
  userId: string,
  workflowRunId: string
): Promise<{ orgId: string; role: "owner" | "editor" | "viewer"; workflowId: string } | null> {
  const data = await adminGraphQL<{
    workflow_runs_by_pk: { org_id: string; workflow_id: string } | null;
  }>(
    `query($id: uuid!) {
      workflow_runs_by_pk(id: $id) { org_id workflow_id }
    }`,
    { id: workflowRunId }
  );

  const orgId = data.workflow_runs_by_pk?.org_id;
  const workflowId = data.workflow_runs_by_pk?.workflow_id;
  if (!orgId || !workflowId) return null;

  const member = await adminGraphQL<{
    org_members: { role: "owner" | "editor" | "viewer" }[];
  }>(
    `query($orgId: uuid!, $userId: uuid!) {
      org_members(where: { org_id: { _eq: $orgId }, user_id: { _eq: $userId } }, limit: 1) {
        role
      }
    }`,
    { orgId, userId }
  );

  const role = member.org_members[0]?.role;
  if (!role) return null;

  return { orgId, role, workflowId };
}
