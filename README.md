# n8n-lite — Mini AI Workflow Builder

A multi-tenant, n8n-style workflow builder: organizations invite members
with roles, build workflows out of typed steps (LLM calls, HTTP requests,
conditional branches, human approval gates, DB writes, notifications), and
run them via manual clicks, webhooks, or (architecturally) schedules — with
every execution persisted step-by-step to Postgres and streamed live to the
frontend over a GraphQL subscription.

Built on **Nhost + Hasura + PostgreSQL + Next.js**, with **Hasura Actions**
driving execution and **Hasura Event Triggers** driving notification
delivery.

> **Status of this build — read this first.** This repository was built
> from scratch inside a sandboxed environment with no network access to any
> Nhost/Hasura/LLM/Vercel infrastructure and no provided credentials at
> build time. Every file here is real, complete code, and `npm install`,
> `tsc --noEmit`, `next lint`, and `next build` all pass against it (see
> "Testing performed" below). **No GraphQL query, Action, subscription, or
> security test has been executed against a live Hasura instance** — that
> requires you to provision Nhost/Hasura (or point this at an existing
> project) and follow "Local setup" below. Treat every security guarantee
> in this document as "implemented and code-reviewed," not "verified in
> production," until you've run the scripts in `scripts/security-tests/`
> yourself.

---

## 1. Architecture

```
 Browser (Next.js/React)
   │  Apollo Client (JWT from Nhost auth attached automatically)
   ▼
 Hasura GraphQL  ───────────────►  PostgreSQL (Nhost-managed)
   │  Actions (triggerWorkflowRun, approveStep)     ▲
   │  Event Trigger (notification_events INSERT)    │ row-level permissions
   ▼                                                  │ (org_members-based)
 Next.js API routes (this repo, deployed as the Action/Event handler)
   │  lib/execution/engine.ts  — runs steps, retries, pause/resume
   │  lib/llm.ts               — Groq / Gemini / OpenRouter / stub
   ▼
 External APIs (LLM provider, arbitrary http_request targets, Slack)
```

- **Frontend** talks to Hasura directly for reads/writes/subscriptions
  (`lib/graphql/documents.ts`), and calls two Hasura **Actions** for
  anything that needs server-side authorization beyond row filters:
  `triggerWorkflowRun` and `approveStep`.
- **Hasura** owns all row-level security (Layer 1 + most of Layer 2 — see
  §4) and forwards Action calls to this repo's `/api/actions/*` routes,
  and Event Trigger deliveries to `/api/webhooks/notify`.
- **The execution engine** (`lib/execution/engine.ts`) is plain
  TypeScript, invoked directly inside the Action handler's request/response
  cycle — see "Known limitations" for why, and the production alternative.
- **PostgreSQL** is the single source of truth; every step's input/output,
  every retry, every approval is persisted before the engine moves on.

---

## 2. Features

- Organizations, membership, and three roles (owner/editor/viewer)
- Workflow builder: create/edit workflows, add/remove/reorder/configure
  steps, attach triggers
- Step types: `llm_call`, `http_request`, `db_write`, `notify`,
  `conditional_branch`, `approval_gate`
- Trigger types: `manual` (implemented) and `webhook` (implemented,
  inbound HTTP endpoint); `scheduled`/`database_event` are modeled in the
  schema and UI-selectable but have no scheduler wired up (see Limitations)
- Real LLM call via Groq/Gemini/OpenRouter, or a documented stub mode with
  artificial delay
- Retry (2 attempts total) for `llm_call` and `http_request`
- Conditional branching that genuinely skips/executes different downstream
  steps based on the LLM's output
- Human-in-the-loop approval gate: pauses the run, persists `paused`
  status, resumes only via the authorized `approveStep` Action
- Atomic, race-safe quota enforcement (`try_consume_org_quota` SQL function)
- Live execution view via GraphQL subscription (no polling)
- Two-layer authorization — org+role row-level permissions, plus
  step-type restrictions enforced in the same permission layer

---

## 3. Database schema

See `db/migrations/0001_init.sql` and `0002_views_and_functions.sql` for
the full DDL with comments. Summary:

| Table | Purpose |
|---|---|
| `organizations` | tenant + usage/quota fields |
| `org_members` | `(org_id, user_id)` unique, `role` enum — **the security anchor** |
| `workflows` | belongs to an org |
| `workflow_steps` | ordered, typed, `config jsonb` |
| `workflow_triggers` | manual / webhook / scheduled / database_event |
| `workflow_runs` | one execution; status pending→running→paused→completed/failed/cancelled |
| `step_runs` | one step's execution within a run; input/output/error/attempts/approval |
| `workflow_data_records` | application-owned table `db_write` steps write into (not raw SQL) |
| `notification_events` | rows a `notify` step inserts; an Event Trigger delivers them |

Two views serve the "at least one useful aggregation" requirement:

- `org_usage_view` — usage_calls / usage_limit / usage_remaining per org
- `workflow_run_stats_view` — completed/failed run counts and **average
  run duration** per workflow, exposed in GraphQL as
  `workflows { run_stats { avg_duration_seconds } }`

---

## 4. Security model

### Layer 1 — organization + role

Hasura session variables only carry a single `X-Hasura-Role` per request.
Because a user can be `owner` in one org and `viewer` in another, roles are
**not** mapped onto Hasura roles directly. Every authenticated request uses
one Hasura role, `user` (Nhost's default), and every permission's `filter`
/ `check` expression walks a relationship down to `org_members` and tests:

```yaml
org_members:
  _and:
    - user_id: { _eq: X-Hasura-User-Id }
    - role: { _in: [owner, editor] }   # or whichever roles the operation allows
```

This means a client-supplied `org_id` (or `workflow_id`, `workflow_run_id`,
...) is never trusted on its own — access is only granted if a matching
`org_members` row exists for the caller. Guessing another org's ID gets
you an empty result / `null` / a rejected mutation, not data. See
`hasura/metadata/databases/default/tables/*.yaml` for every table's
permissions, and `scripts/security-tests/04-cross-org-isolation.mjs`.

### Layer 2 — step-level restrictions

`db_write`, `notify`, and webhook triggers are dangerous enough (arbitrary
external calls, exposing an inbound URL, consuming quota) that only an
**owner** may create them. This is enforced in the same Hasura `check`
expression on `insert_permissions` (see `public_workflow_steps.yaml` /
`public_workflow_triggers.yaml`) — an editor's raw GraphQL mutation is
rejected by Postgres/Hasura itself, regardless of what the UI shows. The
frontend also hides/disables these options for non-owners, but that's a UX
nicety, not the enforcement — `scripts/security-tests/05..07` exercise the
raw-GraphQL path directly.

### Why approval authorization lives in the Action handler, not Hasura permissions

`approveStep` isn't a simple row update — it must (a) resolve the step's
organization from `step_run_id` alone, (b) validate the step really is a
paused `approval_gate` belonging to a workflow_run that is really `paused`,
(c) re-check the caller's role, and (d) **trigger side effects** (resuming
execution, calling external APIs for subsequent steps). Hasura's
declarative permission language can express "who can flip a status column"
but not "resume a multi-step process with retries." So `workflow_runs` and
`step_runs` have **no client-facing insert/update permissions at all** —
they're only ever mutated by the Action handlers using the admin secret,
after those handlers do their own authorization from first principles
(`lib/hasura.ts: getCallerRoleForWorkflowRun`). This also closes the door
on a client fabricating a `completed` run directly via GraphQL.

---

## 5. Workflow execution lifecycle

```
pending --(engine starts)--> running --(hits approval_gate)--> paused
                                 │                                 │
                                 │                     approveStep Action:
                                 │                     validates caller,
                                 │                     records approval,
                                 │                     resumes engine
                                 │                                 │
                                 ▼                                 ▼
                            completed  <──────────────────  running (resumed)
                                 │
                          (or, on any step's
                           final failure)
                                 ▼
                              failed
```

- Each step gets its own `step_runs` row, created `pending`, moved to
  `running` (with `attempt_count` incremented on each retry), then
  `completed` / `failed` / `paused` / `skipped`.
- `conditional_branch` writes `{ branch: "a" | "b" }` to its own output and
  the engine skips any subsequent step whose `config.branch` doesn't match
  — this is a real control-flow decision in `lib/execution/engine.ts`, not
  a UI-only label.
- `approval_gate` finalizes its own step_run as `paused`, sets the
  `workflow_run` to `paused`, and the engine function **returns** — nothing
  continues until `approveStep` calls `runWorkflow({ resumeFromStepId })`
  again, which hydrates prior outputs from completed `step_runs` rows and
  continues from the gate.

## Retry behavior

`llm_call` and `http_request` get up to 2 total attempts (1 retry) with a
linear backoff (`400ms * attempt`). `attempt_count` is persisted after each
attempt so the frontend/subscription can show "Attempts: 2" etc. Other step
types run once — retrying `db_write`/`notify` risks duplicate side effects
without idempotency keys, which is out of scope here (see Limitations).

## Quota enforcement

`organizations.usage_calls` / `usage_limit` are checked and incremented in
a single SQL statement (`try_consume_org_quota`, an `UPDATE ... WHERE
usage_calls + amount <= usage_limit RETURNING *`). Postgres's row lock on
the `UPDATE` makes this atomic under concurrent triggers — two simultaneous
`triggerWorkflowRun` calls cannot both succeed once the org is at its
limit, without needing an explicit transaction/advisory lock. If the
function returns no row, the Action handler rejects with 429 before ever
creating a `workflow_run`.

## Subscription architecture

The run page subscribes to `step_runs(where: { workflow_run_id: { _eq } })`
plus `workflow_runs_by_pk` in a single subscription document
(`WORKFLOW_RUN_STEP_RUNS_SUBSCRIPTION`). Hasura's live-query subscriptions
poll Postgres internally and diff the result set, pushing updates over
the same websocket the Apollo client already holds — no client-side
polling, no manual refetch. The same row-level permissions apply to
subscriptions as to queries, so a viewer or a cross-org user gets the same
filtered (or empty) result stream.

## Trigger architecture

- **Manual**: the frontend calls the `triggerWorkflowRun` Action directly.
- **Webhook** (the required second trigger): `workflow_triggers` rows of
  type `webhook` carry a random `config.secret`, generated client-side and
  only insertable by an owner (Layer 2). An external caller
  `POST`s to `/api/webhooks/trigger/[workflowId]?secret=...` — no login
  required, but the secret must match, and quota + org resolution happen
  server-side exactly like the manual path. See §7 for a `curl` example.
- **Scheduled / database_event**: modeled in the schema and selectable as a
  trigger `type`, but no cron dispatcher or DB-event listener is wired up
  in this build (see Limitations). The natural production path is a
  Hasura **Scheduled Trigger** calling the same `/api/webhooks/trigger/...`
  handler on a cron, or a Hasura **Event Trigger** on whatever table should
  fire the workflow.

---

## 6. Environment variables

Copy `.env.example` to `.env.local` (frontend/Next.js) and fill in:

```
NEXT_PUBLIC_NHOST_SUBDOMAIN=      # from your Nhost project
NEXT_PUBLIC_NHOST_REGION=

NHOST_SUBDOMAIN=                  # same values, server-side convenience
NHOST_REGION=
NHOST_ADMIN_SECRET=               # from Nhost project settings — NEVER expose client-side
NHOST_GRAPHQL_URL=                # https://<subdomain>.hasura.<region>.nhost.run/v1/graphql
NHOST_HASURA_URL=                 # same host, WITHOUT the /v1/graphql suffix

ACTION_SECRET=                    # shared secret between Hasura Actions/Event Triggers and this app
ACTION_BASE_URL=                  # this app's public URL, e.g. your Vercel deployment or an ngrok tunnel

LLM_PROVIDER=groq                 # groq | gemini | openrouter | stub
LLM_API_KEY=                      # leave blank to run llm_call in documented stub mode
LLM_MODEL=llama-3.1-8b-instant

SLACK_WEBHOOK_URL=                # leave blank to run notify in documented stub mode
```

Never commit `.env.local` (already in `.gitignore`).

**No PostgreSQL connection string is used anywhere in this app.** Every
read/write goes through Hasura's GraphQL/admin API (`lib/hasura.ts`),
authenticated with `NHOST_ADMIN_SECRET` — including schema migrations,
which run via Hasura's `/v2/query` SQL-execution endpoint
(`scripts/apply-migrations.mjs`), not a direct `pg` client. There is
deliberately no reason to enable Nhost's "public database access" setting
for this project, and this app never asks you to.

`HASURA_GRAPHQL_ENDPOINT` / `HASURA_GRAPHQL_ADMIN_SECRET` are still
supported as fallback names (`lib/hasura.ts` checks the `NHOST_*` names
first) for anyone self-hosting Hasura outside of Nhost.

---

## 7. Local setup

```bash
# 1. Install dependencies
npm install

# 2. Create/link an Nhost project (app.nhost.io, or `nhost login && nhost link`
#    if you prefer the CLI). Collect NHOST_SUBDOMAIN, NHOST_REGION,
#    NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL, NHOST_HASURA_URL from the
#    project's Settings page.

# 3. Configure this app
cp .env.example .env.local   # fill in the values from step 2
npm install

# 4. Apply the database schema — via Hasura's admin API, no direct
#    Postgres connection or `psql` needed:
export NHOST_HASURA_URL=https://<subdomain>.hasura.<region>.nhost.run
export NHOST_ADMIN_SECRET=<your admin secret>
npm run migrate
#    (runs db/migrations/*.sql through scripts/apply-migrations.mjs)

# 5. Apply Hasura metadata (tables, relationships, permissions, actions)
#    IMPORTANT: do NOT run `hasura metadata apply` with only this repo's
#    metadata/ directory — it performs a full replace and would wipe out
#    Nhost's own auth/storage metadata (breaking login). Use the safe
#    export-then-merge workflow instead:
cd hasura
hasura metadata export --envfile ../.env.local   # pulls Nhost's current metadata,
                                                   # including auth/storage tracking,
                                                   # into ./metadata (overwriting the
                                                   # placeholder files from this repo)
#    Now re-add this project's tables/actions on top of what was exported:
#    copy the contents of the *_public_*.yaml table files and actions.yaml/
#    actions.graphql from this repo's original hasura/metadata/ (see the
#    zip you downloaded, or `git diff`/`git stash` if you're in version
#    control) into the freshly exported directory, then:
hasura metadata apply --envfile ../.env.local
#    This applies the MERGED metadata — Nhost's required tracking plus
#    this app's tables/relationships/permissions/actions — never a blind
#    replace.

# 6. Start the app
npm run dev
# app on http://localhost:3000

# 7. Expose this app to Hasura for Actions/Event Triggers
#    Hasura Cloud/Nhost need a public URL to call your /api/actions/* and
#    /api/webhooks/notify routes. For local dev:
ngrok http 3000
#    then set ACTION_BASE_URL to the ngrok URL and re-run
#    `hasura metadata apply` (same merged directory from step 5).

# 8. Seed demo users/orgs — see §9 below.

# 9. Test the webhook trigger directly:
curl -X POST "http://localhost:3000/api/webhooks/trigger/<workflow_id>?secret=<trigger_secret>"
```

### Checks run against this codebase (all passing as of this build)

```bash
npm install        # ✅ succeeds
npm run typecheck   # ✅ tsc --noEmit — 0 errors
npm run lint         # ✅ eslint — 0 errors/warnings
npm run build         # ✅ next build — all 11 routes compile (4 static, 3 dynamic pages, 4 API routes)
npm run test:security  # ✅ runs all 10 scripts; all report SKIPPED (no live Hasura endpoint
                        #    in this environment) — see §10 for what's required to turn these green
```

---

## 8. Deployment

**Frontend + Action/Event handlers (this repo) → Vercel:**

```bash
npm i -g vercel
vercel link
vercel env add NHOST_GRAPHQL_URL
vercel env add NHOST_HASURA_URL
vercel env add NHOST_ADMIN_SECRET
vercel env add ACTION_SECRET
vercel env add LLM_API_KEY        # etc. — every var from .env.example
vercel --prod
```

After deploying, set `ACTION_BASE_URL` to the resulting `https://your-app.vercel.app`
and re-apply the merged Hasura metadata (§7 step 5) so `actions.yaml` / the
notify event trigger point at production, not localhost/ngrok.

**Backend (Postgres + Hasura + Auth) → Nhost:** provisioned in step 2
above; Nhost hosts Hasura and Postgres for you, so there's no separate
"deploy Hasura" step — applying the merged metadata (§7 step 5) against
your Nhost project's endpoint is the deployment. No database is ever
exposed publicly; all schema changes go through Hasura's admin API.

**CORS:** Hasura on Nhost allows all origins by default for the GraphQL
endpoint; if you've locked it down, add your Vercel domain. The Next.js
API routes in this repo don't need CORS config since they're only ever
called server-to-server (Hasura → this app), not from the browser.

I have not performed this deployment myself (no Vercel/Nhost credentials
in this environment) — the commands above are correct and complete but
unexecuted. See the Completion Report for the honest status.

---

## 9. Demo users/organizations

1. Sign up six users via `/auth/sign-up` (Owner A, Editor A, Viewer A,
   Owner B, Editor B, Viewer B — any emails you like).
2. Find their `auth.users.id` values:
   `select id, email from auth.users order by created_at desc limit 6;`
3. Run `db/seed_demo_orgs.sql` to create Org A / Org B, then insert the six
   `org_members` rows (owner/editor/viewer × 2 orgs) using those IDs —
   template included in that file.
4. Sign in as Owner A, open the dashboard, and build the demo workflow
   (§10) inside Org A.

---

## 10. Final scenario — exact reproduction steps

1. **Build the workflow** (as Owner A, in the builder for a new "Approval
   Demo" workflow inside Org A):
   - Step 1 `llm_call` — prompt: *"Does this refund request meet our
     policy? Reply APPROVE or REJECT with reasoning."*
   - Step 2 `http_request` — `GET https://httpbin.org/get` (stands in for
     an external lookup)
   - Step 3 `conditional_branch` — `{ source: "lastLLMOutput", match:
     "APPROVE" }`
   - Step 4 `approval_gate`
   - Step 5 `db_write` — `{ key: "final_decision" }`
   - Add a `manual` trigger, and (as owner) a `webhook` trigger — note the
     generated secret shown in the builder.
2. **Start manually**: click **Run**. Watch the run page — steps 1–3 go
   `pending → running → completed` live via the subscription, then the
   run hits step 4 and both the step and the run flip to `paused`
   immediately (no refresh needed).
3. **Approve**: still signed in as Owner A (or Editor A), click **Approve**
   on the paused step. The Action re-checks org+role, records
   `approved_by`/`approved_at`, and resumes — steps continue live to
   `completed`.
4. **Second trigger**: from a terminal, `curl -X POST
   ".../api/webhooks/trigger/<workflow_id>?secret=<secret>"` — a second
   `workflow_run` appears with `trigger_type: webhook`, started without
   touching the Run button.
5. **Org B isolation**: sign in as Owner B (or Editor B/Viewer B). Attempt
   to open Org A's workflow builder URL directly, query its workflows,
   trigger its workflow by ID, or approve its paused step by ID — all
   should return not-found/empty/denied. This is exactly what
   `scripts/security-tests/04, 05, 08` assert programmatically.

---

## 11. Known limitations

- **Execution engine is synchronous, in-request.** A very long-running
  `http_request` or a workflow with many steps holds the Action handler's
  HTTP connection open for the whole run (bounded by the 60s Action
  timeout in `actions.yaml`). Production fix: move step execution onto a
  queue/worker (a Postgres job table + a polling worker, or Hasura
  Scheduled Triggers ticking a "process next pending step" endpoint) so
  `triggerWorkflowRun` returns immediately with `status: running` and the
  UI's subscription is the only thing that needs to be live. The
  pause/resume contract (`resumeFromStepId`) does not change under that
  refactor.
- **Scheduled and database_event triggers are schema-complete but not
  wired to a dispatcher.** `workflow_triggers.type` supports them and the
  builder UI lets you select them, but nothing currently polls a cron or
  listens for DB changes to invoke `/api/webhooks/trigger/...`
  automatically. The webhook trigger (required by the assignment as the
  "prefer webhook" option) is fully implemented and is the second trigger
  demonstrated in §10.
- **`db_write`/`notify` are not retried.** Retrying them risks duplicate
  writes/duplicate notifications without an idempotency key on
  `workflow_data_records`/`notification_events`; only `llm_call` and
  `http_request` retry, per the assignment's "at least one retry for
  llm_call and http_request."
- **No real Nhost/Hasura/LLM/Vercel testing has been performed** in this
  build (see the banner at the top and the Completion Report at the end
  of the accompanying message). Every ✅ in that report reflects a command
  I actually ran; anything not run is marked accordingly.
- **`@nhost/react` / `@nhost/react-apollo` are on Nhost's deprecated
  "legacy JS SDK" track** (security patches only, no new features, per
  npm's deprecation notice at install time). They were chosen because they
  provide the hooks-based auth/Apollo integration this build needs with
  the least code; migrating to the new `@nhost/nhost-js` v4 SDK later is a
  frontend-only change (`lib/nhost/client.ts`, `app/providers.tsx`, and the
  `use*` hooks) and does not touch the schema, Hasura metadata, or Action
  handlers.
- **No automated UI/e2e tests** (Playwright/Cypress) — only the backend
  security scripts in `scripts/security-tests/`, per the assignment's
  explicit instruction to test GraphQL/backend behavior directly rather
  than only UI behavior.

---

## 12. Repository map

```
db/migrations/                         schema + views + quota function
db/seed_demo_orgs.sql                  demo org/member seed template
hasura/metadata/                       tables, relationships, permissions, actions
hasura/config.yaml                     Hasura CLI project config
lib/hasura.ts                          admin GraphQL client + role-lookup helpers
lib/actionAuth.ts                      Action-request auth helpers
lib/llm.ts                             LLM provider wrapper + stub
lib/execution/engine.ts                the execution engine
lib/graphql/documents.ts               all frontend GraphQL queries/mutations/subscriptions
lib/nhost/client.ts                    Nhost client singleton
app/api/actions/trigger-workflow-run/  triggerWorkflowRun Action handler
app/api/actions/approve-step/          approveStep Action handler
app/api/webhooks/trigger/[workflowId]/ inbound webhook trigger endpoint
app/api/webhooks/notify/               Event Trigger handler for notify delivery
app/auth/                              sign-in / sign-up
app/dashboard/                         org selector, usage, workflow list
app/workflows/[id]/builder/            workflow builder UI
app/workflows/[id]/run/[runId]/        live execution + approval UI
scripts/security-tests/                backend security test scripts (§10 in this README)
WRITEUP.md                             ~1 page design rationale
```
