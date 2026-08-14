-- 0003_org_invitations.sql
--
-- Supports owner-driven member onboarding without any manual
-- Hasura-console/PowerShell/admin-secret step per new user.
--
-- Flow:
--   1. An owner inserts a row here (org_id, email, role) via a normal
--      Hasura mutation using their own JWT — enforced by the same
--      owner-only insert_permission pattern as every other Layer 2
--      restriction in this app (see hasura/metadata .../public_org_invitations.yaml).
--   2. The owner shares the resulting invite link (/invite/<token>) with
--      the invitee through any channel (this app does not send email —
--      same documented stub philosophy as the `notify` step).
--   3. The invitee signs up/signs in, opens the link, and the frontend
--      calls the `acceptInvitation(token)` Action. The Action
--      independently verifies the caller's authenticated email matches
--      the invitation (via an admin-secret lookup against auth.users —
--      never trusting a client-supplied email) before creating the
--      org_members row. See app/api/actions/accept-invitation/route.ts.

do $$ begin
  create type public.invitation_status as enum ('pending', 'accepted', 'revoked');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.org_invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  email        text not null,
  role         public.org_role not null default 'viewer',
  invited_by   uuid not null, -- auth.users(id)
  token        uuid not null default gen_random_uuid() unique,
  status       public.invitation_status not null default 'pending',
  accepted_by  uuid, -- auth.users(id)
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_org_invitations_org_id on public.org_invitations(org_id);
create index if not exists idx_org_invitations_token on public.org_invitations(token);
create index if not exists idx_org_invitations_email on public.org_invitations(lower(email));

comment on table public.org_invitations is
  'Owner-created pending invitations. Insert is a normal owner-scoped Hasura permission (client-safe). Acceptance is server-authorized via the acceptInvitation Action, which verifies the caller''s real email before creating org_members — never trusts a client-supplied email or org_id.';
