// app/api/actions/accept-invitation/route.ts
//
// Hasura Action handler for `acceptInvitation(token: uuid!)`.
//
// Security model: the client never gets admin-secret access. This
// handler independently verifies the AUTHENTICATED caller's real email
// (looked up server-side from auth.users via the admin secret, using
// their verified X-Hasura-User-Id — never a client-supplied email)
// matches the invitation's target email, before creating the
// org_members row. This closes the obvious attack: a malicious client
// cannot accept an invitation meant for someone else's email just by
// knowing/guessing the token, because token possession alone is not
// sufficient — the email match is re-verified here every time.

import { NextRequest } from "next/server";
import { assertActionSecret, getCallerUserId, ActionRequestBody, UnauthorizedError } from "@/lib/actionAuth";
import { adminGraphQL } from "@/lib/hasura";

interface Input {
  token: string;
}

interface InvitationLookup {
  org_invitations: {
    id: string;
    org_id: string;
    email: string;
    role: "owner" | "editor" | "viewer";
    status: "pending" | "accepted" | "revoked";
  }[];
}

interface UserLookup {
  user: { email: string } | null;
}

export async function POST(req: NextRequest) {
  try {
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

    const { token } = body.input;
    if (!token) {
      return Response.json({ message: "token is required" }, { status: 400 });
    }

    // --- Look up the invitation by token (admin secret — client never sees this table's other rows) ---
    const inviteResult = await adminGraphQL<InvitationLookup>(
      `query($token: uuid!) {
        org_invitations(where: { token: { _eq: $token } }, limit: 1) {
          id org_id email role status
        }
      }`,
      { token }
    );
    const invitation = inviteResult.org_invitations[0];
    if (!invitation) {
      return Response.json({ message: "Invitation not found" }, { status: 404 });
    }
    if (invitation.status !== "pending") {
      return Response.json({ message: `Invitation is ${invitation.status}, not pending` }, { status: 409 });
    }

    // --- Independently resolve the CALLER's real email server-side ------------
    // Never trust a client-supplied email — only what auth.users has for
    // the verified X-Hasura-User-Id from the caller's JWT.
    const userResult = await adminGraphQL<UserLookup>(
      `query($id: uuid!) { user(id: $id) { email } }`,
      { id: userId }
    );
    const callerEmail = userResult.user?.email;
    if (!callerEmail) {
      return Response.json({ message: "Could not resolve your account email" }, { status: 500 });
    }

    if (callerEmail.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
      // Deliberately generic — do not confirm/deny whether a *different*
      // email has a pending invitation with this token.
      return Response.json(
        { message: "This invitation was issued to a different email address" },
        { status: 403 }
      );
    }

    // --- Create org_members (admin secret — server-authorized write, same trust
    // model as workflow_runs/step_runs writes elsewhere in this app) -----------
    // ON CONFLICT handles the case where the user is already a member
    // (e.g. double-accept, or an owner separately added them already) —
    // treat as idempotent success rather than a hard error.
    await adminGraphQL(
      `mutation($orgId: uuid!, $userId: uuid!, $role: org_role!) {
        insert_org_members_one(
          object: { org_id: $orgId, user_id: $userId, role: $role }
          on_conflict: { constraint: org_members_org_id_user_id_key, update_columns: [] }
        ) { id }
      }`,
      { orgId: invitation.org_id, userId, role: invitation.role }
    );

    await adminGraphQL(
      `mutation($id: uuid!, $userId: uuid!, $now: timestamptz!) {
        update_org_invitations_by_pk(
          pk_columns: { id: $id }
          _set: { status: accepted, accepted_by: $userId, accepted_at: $now }
        ) { id }
      }`,
      { id: invitation.id, userId, now: new Date().toISOString() }
    );

    return Response.json({ org_id: invitation.org_id, role: invitation.role, status: "accepted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("accept-invitation: unhandled error:", err);
    return Response.json({ message: `Internal error: ${message}` }, { status: 500 });
  }
}
