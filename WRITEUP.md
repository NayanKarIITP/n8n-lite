# Design write-up

**1. Schema reasoning.** The schema separates *definition* (workflows,
workflow_steps, workflow_triggers) from *execution* (workflow_runs,
step_runs) because they have different lifecycles and different write
paths: definitions are edited interactively by users through normal Hasura
mutations, while executions are append-only records written exclusively by
the Action handler after authorization. `workflow_data_records` and
`notification_events` are separate, narrow, application-owned tables
rather than letting `db_write`/`notify` touch arbitrary tables or run
arbitrary SQL — this keeps the "dangerous" step types dangerous only in a
bounded, auditable way.

**2. Why `org_members` is used for isolation.** A denormalized `org_id`
column on a resource is not a security boundary — anyone can *read* an ID,
so filtering `where org_id = <client value>` would let a client claim
membership in any org just by knowing its ID. `org_members` inverts this:
every permission walks a relationship *to* `org_members` and filters on
`X-Hasura-User-Id`, a value Hasura derives from the verified JWT, not from
client input. There is no code path where a client-supplied org/workflow ID
alone grants access — a matching `org_members` row is structurally
required.

**3. Layer 1 permissions.** Implemented as Hasura row-level `filter`/`check`
expressions on a single `user` Hasura role (not per-role Hasura roles —
see README §4 for why: a user's role varies per org, but Hasura's role
session variable doesn't). Every table's permission composes two
conditions through the `org_members` relationship: membership
(`user_id = X-Hasura-User-Id`) and authorization (`role _in [...]`
appropriate to the operation).

**4. Layer 2 step-level permissions.** `db_write`, `notify`, and webhook
triggers are restricted inside the *same* Hasura `check` expression used
for Layer 1, expressed as an `_or` of "editor AND type is not restricted"
/ "owner, any type." This means the restriction is enforced at the exact
point of insertion, by the same mechanism as org isolation, and can't be
bypassed by any GraphQL client regardless of what the UI shows or hides.

**5. Why approval authorization is enforced in the Action handler.**
Hasura's permission DSL can gate a column update but can't express
"resolve the resource's org from a foreign id chain, validate multi-table
state (step type, step status, run status), record two extra columns, and
then resume a stateful multi-step process." So `approveStep` — and
`triggerWorkflowRun` — are Hasura Actions: normal HTTP handlers that
receive Hasura's verified session variables, do their own authorization
from first principles against `org_members` (never trusting the
`workflow_id`/`step_run_id` the client passed as proof of anything), and
only then use the admin secret to mutate state. `workflow_runs` and
`step_runs` have zero client-facing write permissions specifically so this
is the *only* way those tables change.

**6. Workflow execution lifecycle.** `pending` (row created, not yet
started) → `running` (engine executing steps in position order, one
`step_runs` row per step) → either `paused` (hit an `approval_gate`; engine
returns without erroring) → `running` again (resumed by `approveStep`,
which reconstructs prior step outputs from completed `step_runs` before
continuing) → `completed`/`failed`.

**7. Retry behavior.** Only `llm_call` and `http_request` retry (2 attempts
total, linear backoff), because they're the two step types calling
inherently flaky external services; `db_write`/`notify`/`conditional_branch`
are either idempotent-unsafe to retry blindly or purely computational.
`attempt_count` persists after every attempt so the UI can surface it live.

**8. Quota enforcement.** A single SQL `UPDATE organizations SET
usage_calls = usage_calls + 1 WHERE usage_calls + 1 <= usage_limit
RETURNING *` is both the check and the increment. Postgres's row lock
during the `UPDATE` serializes concurrent callers against the same row, so
two simultaneous trigger requests can't both slip through when only one
unit of quota remains — no explicit transaction or advisory lock needed.

**9. Subscription architecture.** The run page holds one GraphQL
subscription (`step_runs` filtered by `workflow_run_id`, plus
`workflow_runs_by_pk`) for the lifetime of the page. Hasura's live queries
push diffed results over the existing websocket whenever the underlying
rows change — since the engine's every state transition is a real
Postgres write, the UI needs zero polling and zero manual refetch to show
`pending → running → completed/paused` transitions as they happen.

**10. Trigger architecture.** `manual` and `webhook` are both implemented
uniformly underneath: both resolve an org, check quota atomically, create
a `workflow_run`, and call the same `runWorkflow()`. They differ only in
*how the caller is authorized* — `manual` via a signed-in user's role,
`webhook` via a per-trigger secret that only an owner could have minted
(itself a Layer 2 restriction). `scheduled`/`database_event` are
schema-complete and UI-selectable but have no dispatcher wired up in this
build (see README "Known limitations") — the natural extension is a
Hasura Scheduled Trigger or Event Trigger calling the same webhook
endpoint, requiring no changes to the engine or authorization model.
