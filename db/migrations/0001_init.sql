-- 0001_init.sql
-- Core schema for the mini n8n-style AI workflow builder.
-- Designed for Postgres as provisioned by Nhost. Run via Hasura migrations
-- (hasura migrate apply) or directly with psql — see README "Local setup".

create extension if not exists pgcrypto;

-- =========================================================================
-- organizations
-- =========================================================================
create table if not exists public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  usage_calls   integer not null default 0,
  usage_limit   integer not null default 100,
  period_start  timestamptz not null default date_trunc('month', now()),
  period_end    timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.organizations is 'Tenant boundary. Every permission check ultimately reduces to org_members membership in this table.';

-- =========================================================================
-- org_members  — the single source of truth for Layer 1 authorization
-- =========================================================================
do $$ begin
  create type public.org_role as enum ('owner', 'editor', 'viewer');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null, -- references auth.users(id) (Nhost auth schema) — see note below
  role       public.org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists idx_org_members_org_id on public.org_members(org_id);
create index if not exists idx_org_members_user_id on public.org_members(user_id);

comment on table public.org_members is
  'Layer 1 security anchor. Every Hasura permission on org-scoped tables filters through a relationship that resolves to a row here matching X-Hasura-User-Id. Never trust a client-supplied org_id directly.';

-- If deploying on Nhost, uncomment to add a real FK to auth.users:
-- alter table public.org_members
--   add constraint org_members_user_id_fkey
--   foreign key (user_id) references auth.users(id) on delete cascade;

-- =========================================================================
-- workflows
-- =========================================================================
create table if not exists public.workflows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid not null, -- auth.users(id)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_workflows_org_id on public.workflows(org_id);

-- =========================================================================
-- workflow_steps
-- =========================================================================
do $$ begin
  create type public.step_type as enum (
    'llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.workflow_steps (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references public.workflows(id) on delete cascade,
  position     integer not null,
  type         public.step_type not null,
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workflow_id, position)
);

create index if not exists idx_workflow_steps_workflow_id on public.workflow_steps(workflow_id);

comment on column public.workflow_steps.type is
  'db_write, notify and (via workflow_triggers) webhook are restricted to owner — enforced both in Hasura insert permissions (see permissions.yaml) and re-checked in the trigger-workflow-run Action for defense in depth.';

-- =========================================================================
-- workflow_triggers
-- =========================================================================
do $$ begin
  create type public.trigger_type as enum ('manual', 'webhook', 'scheduled', 'database_event');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.workflow_triggers (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  type        public.trigger_type not null,
  config      jsonb not null default '{}'::jsonb, -- e.g. {"secret": "..."} for webhook, {"cron": "*/15 * * * *"} for scheduled
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_workflow_triggers_workflow_id on public.workflow_triggers(workflow_id);

-- =========================================================================
-- workflow_runs
-- =========================================================================
do $$ begin
  create type public.run_status as enum (
    'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.workflow_runs (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references public.workflows(id) on delete cascade,
  org_id       uuid not null references public.organizations(id) on delete cascade, -- denormalized for cheap RLS-style checks
  status       public.run_status not null default 'pending',
  trigger_type public.trigger_type not null default 'manual',
  triggered_by uuid, -- auth.users(id), null for non-manual triggers
  started_at   timestamptz,
  completed_at timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_workflow_runs_workflow_id on public.workflow_runs(workflow_id);
create index if not exists idx_workflow_runs_org_id on public.workflow_runs(org_id);
create index if not exists idx_workflow_runs_status on public.workflow_runs(status);

-- =========================================================================
-- step_runs
-- =========================================================================
do $$ begin
  create type public.step_run_status as enum (
    'pending', 'running', 'completed', 'failed', 'paused', 'skipped'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.step_runs (
  id               uuid primary key default gen_random_uuid(),
  workflow_run_id  uuid not null references public.workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references public.workflow_steps(id) on delete cascade,
  status           public.step_run_status not null default 'pending',
  input            jsonb,
  output           jsonb,
  error            text,
  attempt_count    integer not null default 0,
  approved_by      uuid, -- auth.users(id)
  approved_at      timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_step_runs_workflow_run_id on public.step_runs(workflow_run_id);
create index if not exists idx_step_runs_workflow_step_id on public.step_runs(workflow_step_id);
create index if not exists idx_step_runs_status on public.step_runs(status);

-- =========================================================================
-- application-owned table that db_write steps are allowed to write into
-- (deliberately NOT arbitrary SQL — see assignment "db_write" requirement)
-- =========================================================================
create table if not exists public.workflow_data_records (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  step_run_id     uuid not null references public.step_runs(id) on delete cascade,
  key             text not null,
  value           jsonb not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_workflow_data_records_org_id on public.workflow_data_records(org_id);
create index if not exists idx_workflow_data_records_run_id on public.workflow_data_records(workflow_run_id);

-- =========================================================================
-- notify log — event-driven notify step lands a row here; a Hasura Event
-- Trigger on INSERT calls the notification webhook handler.
-- =========================================================================
create table if not exists public.notification_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  step_run_id uuid not null references public.step_runs(id) on delete cascade,
  channel     text not null default 'stub', -- 'slack' | 'email' | 'stub'
  payload     jsonb not null default '{}'::jsonb,
  delivered   boolean not null default false,
  delivered_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_notification_events_org_id on public.notification_events(org_id);

-- =========================================================================
-- updated_at triggers
-- =========================================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_organizations_updated_at on public.organizations;
create trigger trg_organizations_updated_at before update on public.organizations
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_org_members_updated_at on public.org_members;
create trigger trg_org_members_updated_at before update on public.org_members
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_workflows_updated_at on public.workflows;
create trigger trg_workflows_updated_at before update on public.workflows
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_workflow_steps_updated_at on public.workflow_steps;
create trigger trg_workflow_steps_updated_at before update on public.workflow_steps
  for each row execute procedure public.set_updated_at();
