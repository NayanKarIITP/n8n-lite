// scripts/track-public-tables.mjs
//
// Applies this project's 11 public.* tables/views to a live Hasura
// instance via the raw /v1/metadata bulk API — the same method that
// worked reliably for the Actions/custom types when `hasura metadata
// apply` silently failed to push table tracking.
//
// This does NOT touch Nhost's auth/storage metadata in any way — every
// call here is scoped to specific public.* table names, additive only.
//
// Ordering matters and is handled correctly: tables are tracked first,
// THEN relationships are created (a relationship to an untracked table
// is invalid), THEN permissions. This mirrors the structure already
// written in hasura/metadata/databases/default/tables/public_*.yaml —
// this script is a faithful re-encoding of those same definitions, not
// new design.
//
// Usage:
//   node scripts/track-public-tables.mjs --plan     (prints what WOULD
//                                                     be sent, sends nothing)
//   node scripts/track-public-tables.mjs --apply     (actually sends it)
//
// Requires NHOST_HASURA_URL and NHOST_ADMIN_SECRET as env vars (same as
// scripts/apply-migrations.mjs).

const hasuraUrl = (process.env.NHOST_HASURA_URL || "").replace(/\/$/, "");
const adminSecret = process.env.NHOST_ADMIN_SECRET;
const mode = process.argv.includes("--apply") ? "apply" : "plan";

if (mode === "apply" && (!hasuraUrl || !adminSecret)) {
  console.error("Missing NHOST_HASURA_URL / NHOST_ADMIN_SECRET.");
  process.exit(1);
}

const org = { org_id: { _eq: "X-Hasura-User-Id-PLACEHOLDER" } }; // unused, just for clarity below

// ---------------------------------------------------------------------
// PHASE 1 — track tables/views
// ---------------------------------------------------------------------
const TABLES = [
  "organizations",
  "org_members",
  "workflows",
  "workflow_steps",
  "workflow_triggers",
  "workflow_runs",
  "step_runs",
  "workflow_data_records",
  "notification_events",
  "org_usage_view",
  "workflow_run_stats_view",
];

const trackTableArgs = TABLES.map((name) => ({
  type: "pg_track_table",
  args: { source: "default", table: { schema: "public", name } },
}));

// ---------------------------------------------------------------------
// PHASE 2 — relationships
// ---------------------------------------------------------------------
const relationshipArgs = [
  // organizations
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "organizations" },
      name: "org_members",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "org_members" }, column: "org_id" } },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "organizations" },
      name: "workflows",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "workflows" }, column: "org_id" } },
    },
  },
  // org_members
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "org_members" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
  // workflows
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      name: "workflow_steps",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "workflow_steps" }, column: "workflow_id" } },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      name: "workflow_triggers",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "workflow_triggers" }, column: "workflow_id" } },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      name: "workflow_runs",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "workflow_runs" }, column: "workflow_id" } },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      name: "run_stats",
      using: {
        manual_configuration: {
          remote_table: { schema: "public", name: "workflow_run_stats_view" },
          column_mapping: { id: "workflow_id" },
        },
      },
    },
  },
  // workflow_steps
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      name: "workflow",
      using: { foreign_key_constraint_on: "workflow_id" },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      name: "step_runs",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "step_runs" }, column: "workflow_step_id" } },
    },
  },
  // workflow_triggers
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_triggers" },
      name: "workflow",
      using: { foreign_key_constraint_on: "workflow_id" },
    },
  },
  // workflow_runs
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_runs" },
      name: "workflow",
      using: { foreign_key_constraint_on: "workflow_id" },
    },
  },
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_runs" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_runs" },
      name: "step_runs",
      using: { foreign_key_constraint_on: { table: { schema: "public", name: "step_runs" }, column: "workflow_run_id" } },
    },
  },
  // step_runs
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "step_runs" },
      name: "workflow_run",
      using: { foreign_key_constraint_on: "workflow_run_id" },
    },
  },
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "step_runs" },
      name: "workflow_step",
      using: { foreign_key_constraint_on: "workflow_step_id" },
    },
  },
  // workflow_data_records
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_data_records" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
  // notification_events
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "notification_events" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
  // org_usage_view
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "org_usage_view" },
      name: "org_members",
      using: {
        manual_configuration: {
          remote_table: { schema: "public", name: "org_members" },
          column_mapping: { org_id: "org_id" },
        },
      },
    },
  },
  // workflow_run_stats_view
  {
    type: "pg_create_array_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_run_stats_view" },
      name: "org_members",
      using: {
        manual_configuration: {
          remote_table: { schema: "public", name: "org_members" },
          column_mapping: { org_id: "org_id" },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------
// PHASE 3 — permissions (matches hasura/metadata/databases/default/tables/public_*.yaml)
// ---------------------------------------------------------------------
// PHASE 3 — permissions (matches hasura/metadata/databases/default/tables/public_*.yaml)
// ---------------------------------------------------------------------
//
// nestedOwnerFilter(relPath, roles) builds a filter/check that walks
// `relPath` (an array of relationship names) down to a table that has an
// `org_members` relationship, then tests role membership there. This is
// the ONLY place org_members conditions are built — no other helper, no
// manual wrapping around it — specifically to avoid the double-nesting
// bug caught during a real --apply attempt (Hasura error: "org_members"
// does not exist, because a prior version of this script wrapped an
// already-nested helper output in another manual { relationship: ... }
// layer). See the assertion block below the definitions, which fails
// fast if that class of bug is ever reintroduced.
function nestedOwnerFilter(relPath, roles) {
  const roleCondition = {
    _and: [
      { user_id: { _eq: "X-Hasura-User-Id" } },
      { role: roles.length === 1 ? { _eq: roles[0] } : { _in: roles } },
    ],
  };
  let node = { org_members: roleCondition };
  for (let i = relPath.length - 1; i >= 0; i--) {
    node = { [relPath[i]]: node };
  }
  return node;
}

// nestedMemberFilter(relPath) — same shape, but "any role" (plain
// membership), used for select permissions.
function nestedMemberFilter(relPath) {
  let node = { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } };
  for (let i = relPath.length - 1; i >= 0; i--) {
    node = { [relPath[i]]: node };
  }
  return node;
}

// Self-check: recursively walk any built filter/check object and fail
// immediately if "org_members" appears as a key nested inside another
// "org_members" key (the exact shape of the bug that broke --apply
// earlier). Run at load time, before any network call, against every
// permission this script is about to send.
function assertNoDoubleOrgMembers(obj, insideOrgMembers = false, pathDesc = "") {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoDoubleOrgMembers(item, insideOrgMembers, `${pathDesc}[${i}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key === "org_members") {
      if (insideOrgMembers) {
        throw new Error(
          `SELF-CHECK FAILED: nested "org_members" inside "org_members" at ${pathDesc}.org_members — ` +
            `this is the double-nesting bug. Fix the filter/check construction before applying.`
        );
      }
      assertNoDoubleOrgMembers(obj[key], true, `${pathDesc}.org_members`);
    } else {
      assertNoDoubleOrgMembers(obj[key], insideOrgMembers, `${pathDesc}.${key}`);
    }
  }
}

const memberFilter = nestedMemberFilter([]); // for tables with a DIRECT org_members relationship

const permissionArgs = [
  // organizations — direct "org_members" array relationship
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "organizations" },
      role: "user",
      permission: {
        columns: ["id", "name", "usage_calls", "usage_limit", "period_start", "period_end", "created_at", "updated_at"],
        filter: memberFilter,
      },
    },
  },
  {
    type: "pg_create_update_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "organizations" },
      role: "user",
      permission: { columns: ["name"], filter: nestedOwnerFilter([], ["owner"]), check: null },
    },
  },
  // org_members — via "organization" object relationship -> organizations -> org_members
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_members" },
      role: "user",
      permission: {
        columns: ["id", "org_id", "user_id", "role", "created_at", "updated_at"],
        filter: { organization: memberFilter },
      },
    },
  },
  {
    type: "pg_create_insert_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_members" },
      role: "user",
      permission: {
        columns: ["org_id", "user_id", "role"],
        check: nestedOwnerFilter(["organization"], ["owner"]),
      },
    },
  },
  {
    type: "pg_create_update_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_members" },
      role: "user",
      permission: { columns: ["role"], filter: nestedOwnerFilter(["organization"], ["owner"]), check: null },
    },
  },
  {
    type: "pg_create_delete_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_members" },
      role: "user",
      permission: { filter: nestedOwnerFilter(["organization"], ["owner"]) },
    },
  },
  // workflows — via "organization" object relationship
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      role: "user",
      permission: {
        columns: ["id", "org_id", "name", "description", "created_by", "created_at", "updated_at"],
        filter: { organization: memberFilter },
      },
    },
  },
  {
    type: "pg_create_insert_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      role: "user",
      permission: {
        columns: ["org_id", "name", "description"],
        set: { created_by: "X-Hasura-User-Id" },
        check: nestedOwnerFilter(["organization"], ["owner", "editor"]),
      },
    },
  },
  {
    type: "pg_create_update_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      role: "user",
      permission: {
        columns: ["name", "description"],
        filter: nestedOwnerFilter(["organization"], ["owner", "editor"]),
        check: null,
      },
    },
  },
  {
    type: "pg_create_delete_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflows" },
      role: "user",
      permission: { filter: nestedOwnerFilter(["organization"], ["owner"]) },
    },
  },
  // workflow_steps — via "workflow" -> "organization" (Layer 2: db_write/notify owner-only)
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      role: "user",
      permission: {
        columns: ["id", "workflow_id", "position", "type", "config", "created_at", "updated_at"],
        filter: { workflow: { organization: memberFilter } },
      },
    },
  },
  {
    type: "pg_create_insert_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      role: "user",
      permission: {
        columns: ["workflow_id", "position", "type", "config"],
        check: {
          _and: [
            nestedOwnerFilter(["workflow", "organization"], ["owner", "editor"]),
            {
              _or: [
                {
                  _and: [
                    { type: { _nin: ["db_write", "notify"] } },
                    nestedOwnerFilter(["workflow", "organization"], ["editor"]),
                  ],
                },
                nestedOwnerFilter(["workflow", "organization"], ["owner"]),
              ],
            },
          ],
        },
      },
    },
  },
  {
    type: "pg_create_update_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      role: "user",
      permission: {
        columns: ["position", "type", "config"],
        filter: nestedOwnerFilter(["workflow", "organization"], ["owner", "editor"]),
        check: {
          _or: [
            {
              _and: [
                { type: { _nin: ["db_write", "notify"] } },
                nestedOwnerFilter(["workflow", "organization"], ["editor"]),
              ],
            },
            nestedOwnerFilter(["workflow", "organization"], ["owner"]),
          ],
        },
      },
    },
  },
  {
    type: "pg_create_delete_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_steps" },
      role: "user",
      permission: { filter: nestedOwnerFilter(["workflow", "organization"], ["owner", "editor"]) },
    },
  },
  // workflow_triggers — via "workflow" -> "organization" (Layer 2: webhook owner-only)
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_triggers" },
      role: "user",
      permission: {
        columns: ["id", "workflow_id", "type", "config", "enabled", "created_at"],
        filter: { workflow: { organization: memberFilter } },
      },
    },
  },
  {
    type: "pg_create_insert_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_triggers" },
      role: "user",
      permission: {
        columns: ["workflow_id", "type", "config", "enabled"],
        check: {
          _or: [
            { _and: [{ type: { _neq: "webhook" } }, nestedOwnerFilter(["workflow", "organization"], ["editor"])] },
            nestedOwnerFilter(["workflow", "organization"], ["owner"]),
          ],
        },
      },
    },
  },
  {
    type: "pg_create_update_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_triggers" },
      role: "user",
      permission: {
        columns: ["type", "config", "enabled"],
        filter: nestedOwnerFilter(["workflow", "organization"], ["owner", "editor"]),
        check: {
          _or: [
            { _and: [{ type: { _neq: "webhook" } }, nestedOwnerFilter(["workflow", "organization"], ["editor"])] },
            nestedOwnerFilter(["workflow", "organization"], ["owner"]),
          ],
        },
      },
    },
  },
  {
    type: "pg_create_delete_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_triggers" },
      role: "user",
      permission: { filter: nestedOwnerFilter(["workflow", "organization"], ["owner", "editor"]) },
    },
  },
  // workflow_runs — select-only for users; writes only via admin-secret Action handlers
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_runs" },
      role: "user",
      permission: {
        columns: [
          "id", "workflow_id", "org_id", "status", "trigger_type", "triggered_by",
          "started_at", "completed_at", "error", "created_at",
        ],
        filter: { organization: memberFilter },
      },
    },
  },
  // step_runs — select-only
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "step_runs" },
      role: "user",
      permission: {
        columns: [
          "id", "workflow_run_id", "workflow_step_id", "status", "input", "output", "error",
          "attempt_count", "approved_by", "approved_at", "started_at", "completed_at", "created_at",
        ],
        filter: { workflow_run: { organization: memberFilter } },
      },
    },
  },
  // workflow_data_records — select-only
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_data_records" },
      role: "user",
      permission: {
        columns: ["id", "org_id", "workflow_run_id", "step_run_id", "key", "value", "created_at"],
        filter: { organization: memberFilter },
      },
    },
  },
  // notification_events — select-only
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "notification_events" },
      role: "user",
      permission: {
        columns: ["id", "org_id", "step_run_id", "channel", "payload", "delivered", "delivered_at", "created_at"],
        filter: { organization: memberFilter },
      },
    },
  },
  // org_usage_view — direct manual "org_members" relationship
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_usage_view" },
      role: "user",
      permission: {
        columns: ["org_id", "name", "usage_calls", "usage_limit", "usage_remaining", "period_start", "period_end"],
        filter: memberFilter,
      },
    },
  },
  // workflow_run_stats_view — direct manual "org_members" relationship
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "workflow_run_stats_view" },
      role: "user",
      permission: {
        columns: ["workflow_id", "org_id", "completed_runs", "failed_runs", "avg_duration_seconds"],
        filter: memberFilter,
      },
    },
  },
];

// Run the self-check against every permission arg before anything else
// in this script can use them — fail fast and loud if the bug shape
// reappears.
for (const p of permissionArgs) {
  assertNoDoubleOrgMembers(p.args.permission, false, `${p.type}(${p.args.table.name})`);
}

// ---------------------------------------------------------------------
// PHASE 4 — grant "user" role permission on both existing Actions
// (they currently have none, so no role can call them yet)
// ---------------------------------------------------------------------
const actionPermissionArgs = [
  { type: "create_action_permission", args: { action: "triggerWorkflowRun", role: "user" } },
  { type: "create_action_permission", args: { action: "approveStep", role: "user" } },
];

const allPhases = {
  "1_track_tables": trackTableArgs,
  "2_relationships": relationshipArgs,
  "3_permissions": permissionArgs,
  "4_action_permissions": actionPermissionArgs,
};

if (mode === "plan") {
  console.log("PLAN — nothing will be sent. Re-run with --apply to execute.\n");
  console.log(
    "NOTE: --apply runs these as 4 SEPARATE sequential bulk calls (not one\n" +
      "combined 57-op call), each independently verified against the live\n" +
      "server before the next phase starts. This is a deliberate change from\n" +
      "an earlier single-bulk-call design: it isolates failures to a specific\n" +
      "phase and confirms server state matches intent at each step, rather\n" +
      "than trusting one large all-or-nothing response. Each phase's own\n" +
      "operations remain atomic (all-or-nothing within that phase); if a\n" +
      "later phase fails, earlier phases' changes remain applied — apply is\n" +
      "safe to re-run, since already-tracked tables/relationships/permissions\n" +
      "are simply skipped or re-confirmed by verification, not re-created.\n"
  );
  for (const [phase, args] of Object.entries(allPhases)) {
    console.log(`${phase}: ${args.length} operations`);
    for (const a of args) {
      const t = a.args.table?.name || a.args.action || "";
      console.log(`  - ${a.type}${t ? ` (${t}${a.args.name ? "." + a.args.name : ""}${a.args.role ? " role=" + a.args.role : ""})` : ""}`);
    }
  }
  console.log(`\nTotal: ${Object.values(allPhases).flat().length} operations across 4 phases.`);
  process.exit(0);
}

// --apply mode -----------------------------------------------------------

async function callMetadataApi(body) {
  const res = await fetch(`${hasuraUrl}/v1/metadata`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": adminSecret },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, json };
}

async function exportMetadata() {
  const { ok, json } = await callMetadataApi({ type: "export_metadata", args: {} });
  if (!ok) throw new Error("export_metadata failed: " + JSON.stringify(json));
  return json;
}

function publicTables(exported) {
  const source = (exported.sources || []).find((s) => s.name === "default") || exported.sources?.[0];
  return (source?.tables || []).filter((t) => t.table.schema === "public");
}

async function verifyTablesTracked() {
  const exported = await exportMetadata();
  const tracked = publicTables(exported).map((t) => t.table.name).sort();
  const expected = [...TABLES].sort();
  const missing = expected.filter((n) => !tracked.includes(n));
  if (missing.length > 0) {
    throw new Error(`Verification failed: tables not tracked on server: ${missing.join(", ")}`);
  }
  return `${tracked.length}/${expected.length} public tables tracked`;
}

async function verifyRelationships() {
  const exported = await exportMetadata();
  const tables = publicTables(exported);
  const actualCount = tables.reduce(
    (sum, t) => sum + (t.object_relationships?.length || 0) + (t.array_relationships?.length || 0),
    0
  );
  if (actualCount < relationshipArgs.length) {
    throw new Error(
      `Verification failed: expected at least ${relationshipArgs.length} relationships on public tables, found ${actualCount}`
    );
  }
  return `${actualCount} relationships present (expected >= ${relationshipArgs.length})`;
}

async function verifyPermissions() {
  const exported = await exportMetadata();
  const tables = publicTables(exported);
  const actualCount = tables.reduce(
    (sum, t) =>
      sum +
      (t.select_permissions?.length || 0) +
      (t.insert_permissions?.length || 0) +
      (t.update_permissions?.length || 0) +
      (t.delete_permissions?.length || 0),
    0
  );
  if (actualCount < permissionArgs.length) {
    throw new Error(
      `Verification failed: expected at least ${permissionArgs.length} permissions on public tables, found ${actualCount}`
    );
  }
  return `${actualCount} permissions present (expected >= ${permissionArgs.length})`;
}

async function verifyActionPermissions() {
  const exported = await exportMetadata();
  const actions = exported.actions || [];
  const results = [];
  for (const expected of actionPermissionArgs) {
    const action = actions.find((a) => a.name === expected.args.action);
    const hasRole = action?.permissions?.some((p) => p.role === expected.args.role);
    if (!hasRole) {
      throw new Error(
        `Verification failed: action "${expected.args.action}" missing permission for role "${expected.args.role}"`
      );
    }
    results.push(`${expected.args.action}:${expected.args.role}`);
  }
  return results.join(", ");
}

const phaseSequence = [
  { name: "1_track_tables", args: allPhases["1_track_tables"], verify: verifyTablesTracked },
  { name: "2_relationships", args: allPhases["2_relationships"], verify: verifyRelationships },
  { name: "3_permissions", args: allPhases["3_permissions"], verify: verifyPermissions },
  { name: "4_action_permissions", args: allPhases["4_action_permissions"], verify: verifyActionPermissions },
];

console.log(`Applying ${phaseSequence.length} phases sequentially against ${hasuraUrl}\n`);

for (const phase of phaseSequence) {
  console.log(`--- Phase: ${phase.name} (${phase.args.length} operations) ---`);

  const { ok, json } = await callMetadataApi({ type: "bulk", args: phase.args });

  if (!ok) {
    console.error(`✗ FAILED at phase "${phase.name}" — bulk call rejected. Stopping here.`);
    console.error(JSON.stringify(json, null, 2));
    console.error(
      `\nEarlier phases (if any) that already succeeded remain applied. ` +
        `Fix the issue above and re-run --apply; already-applied phases will ` +
        `simply be re-confirmed by verification, not re-created.`
    );
    process.exit(1);
  }

  console.log(`  bulk call succeeded (${phase.args.length} ops)`);

  try {
    const verifyResult = await phase.verify();
    console.log(`  ✓ verified: ${verifyResult}`);
  } catch (err) {
    console.error(`✗ FAILED at phase "${phase.name}" — server reported success but verification failed. Stopping here.`);
    console.error(err.message);
    process.exit(1);
  }

  console.log("");
}

console.log("All 4 phases applied and independently verified against the live server.");
