-- 0002_views_and_functions.sql

-- =========================================================================
-- Aggregation #1: org usage this period (tracked directly on organizations,
-- exposed as a view for a clean GraphQL read model)
-- =========================================================================
create or replace view public.org_usage_view as
select
  o.id as org_id,
  o.name,
  o.usage_calls,
  o.usage_limit,
  greatest(o.usage_limit - o.usage_calls, 0) as usage_remaining,
  o.period_start,
  o.period_end
from public.organizations o;

-- =========================================================================
-- Aggregation #2: average workflow run duration per workflow
-- =========================================================================
create or replace view public.workflow_run_stats_view as
select
  w.id as workflow_id,
  w.org_id,
  count(r.id) filter (where r.status = 'completed') as completed_runs,
  count(r.id) filter (where r.status = 'failed') as failed_runs,
  avg(extract(epoch from (r.completed_at - r.started_at)))
    filter (where r.status = 'completed' and r.started_at is not null and r.completed_at is not null)
    as avg_duration_seconds
from public.workflows w
left join public.workflow_runs r on r.workflow_id = w.id
group by w.id, w.org_id;

-- =========================================================================
-- Atomic quota check-and-increment.
-- Called by the trigger-workflow-run Action inside a single statement so
-- concurrent triggers cannot race past the limit (row lock via UPDATE).
-- Returns the updated row; if no row is returned, quota was exhausted.
-- =========================================================================
create or replace function public.try_consume_org_quota(p_org_id uuid, p_amount integer default 1)
returns setof public.organizations as $$
begin
  return query
    update public.organizations
    set usage_calls = usage_calls + p_amount
    where id = p_org_id
      and usage_calls + p_amount <= usage_limit
    returning *;
end;
$$ language plpgsql;

comment on function public.try_consume_org_quota is
  'Single UPDATE ... WHERE guarantees atomicity under Postgres MVCC + row locking: two concurrent callers cannot both succeed past usage_limit. Caller must check row count of the result.';
