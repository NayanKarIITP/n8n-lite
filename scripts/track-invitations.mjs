// scripts/track-invitations.mjs
//
// Tracks the new org_invitations table + relationship + permissions, and
// creates the acceptInvitation Action + its custom type, via the same
// raw /v1/metadata bulk API approach proven reliable in
// scripts/track-public-tables.mjs (the Hasura CLI silently failed to
// push table tracking in this project; this script bypasses it
// entirely). Same 4-phase, independently-verified, fail-fast structure.
//
// Usage:
//   node scripts/track-invitations.mjs --plan
//   node scripts/track-invitations.mjs --apply
//
// Requires NHOST_HASURA_URL and NHOST_ADMIN_SECRET as env vars.
// Run this AFTER `npm run migrate` has applied
// db/migrations/0003_org_invitations.sql.

const hasuraUrl = (process.env.NHOST_HASURA_URL || "").replace(/\/$/, "");
const adminSecret = process.env.NHOST_ADMIN_SECRET;
const mode = process.argv.includes("--apply") ? "apply" : "plan";

if (mode === "apply" && (!hasuraUrl || !adminSecret)) {
  console.error("Missing NHOST_HASURA_URL / NHOST_ADMIN_SECRET.");
  process.exit(1);
}

// PHASE 1 — track table
const trackTableArgs = [
  { type: "pg_track_table", args: { source: "default", table: { schema: "public", name: "org_invitations" } } },
];

// PHASE 2 — relationships
const relationshipArgs = [
  {
    type: "pg_create_object_relationship",
    args: {
      source: "default",
      table: { schema: "public", name: "org_invitations" },
      name: "organization",
      using: { foreign_key_constraint_on: "org_id" },
    },
  },
];

// PHASE 3 — permissions (owner-only select + insert; no update/delete from client)
const ownerFilter = {
  organization: {
    org_members: { _and: [{ user_id: { _eq: "X-Hasura-User-Id" } }, { role: { _eq: "owner" } }] },
  },
};

const permissionArgs = [
  {
    type: "pg_create_select_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_invitations" },
      role: "user",
      permission: {
        columns: ["id", "org_id", "email", "role", "invited_by", "token", "status", "accepted_by", "accepted_at", "created_at"],
        filter: ownerFilter,
      },
    },
  },
  {
    type: "pg_create_insert_permission",
    args: {
      source: "default",
      table: { schema: "public", name: "org_invitations" },
      role: "user",
      permission: {
        columns: ["org_id", "email", "role"],
        set: { invited_by: "X-Hasura-User-Id" },
        check: ownerFilter,
      },
    },
  },
];

// Self-check, same as track-public-tables.mjs — fail fast if a filter
// object ever gets accidentally double-nested again.
function assertNoDoubleOrgMembers(obj, insideOrgMembers = false, pathDesc = "") {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoDoubleOrgMembers(item, insideOrgMembers, `${pathDesc}[${i}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key === "org_members") {
      if (insideOrgMembers) {
        throw new Error(`SELF-CHECK FAILED: nested "org_members" inside "org_members" at ${pathDesc}.org_members`);
      }
      assertNoDoubleOrgMembers(obj[key], true, `${pathDesc}.org_members`);
    } else {
      assertNoDoubleOrgMembers(obj[key], insideOrgMembers, `${pathDesc}.${key}`);
    }
  }
}
for (const p of permissionArgs) {
  assertNoDoubleOrgMembers(p.args.permission, false, `${p.type}(${p.args.table.name})`);
}

// PHASE 4 — custom type + action + action permission
const actionSetupArgs = [
  {
    type: "set_custom_types",
    args: {
      // NOTE: set_custom_types REPLACES the whole list — must include the
      // two existing output types too, or they'd be dropped.
      scalars: [],
      enums: [],
      input_objects: [],
      objects: [
        {
          name: "TriggerWorkflowRunOutput",
          fields: [
            { name: "workflow_run_id", type: "uuid!" },
            { name: "status", type: "String!" },
          ],
        },
        {
          name: "ApproveStepOutput",
          fields: [
            { name: "step_run_id", type: "uuid!" },
            { name: "workflow_run_id", type: "uuid!" },
            { name: "status", type: "String!" },
          ],
        },
        {
          name: "AcceptInvitationOutput",
          fields: [
            { name: "org_id", type: "uuid!" },
            { name: "role", type: "String!" },
            { name: "status", type: "String!" },
          ],
        },
      ],
    },
  },
];

const createActionArgs = [
  {
    type: "create_action",
    args: {
      name: "acceptInvitation",
      definition: {
        kind: "synchronous",
        arguments: [{ name: "token", type: "uuid!" }],
        output_type: "AcceptInvitationOutput",
        handler: "https://n8n-lite.vercel.app/api/actions/accept-invitation",
        forward_client_headers: true,
        timeout: 30,
        headers: [{ name: "x-action-secret", value_from_env: "ACTION_SECRET" }],
      },
    },
  },
];

const actionPermissionArgs = [{ type: "create_action_permission", args: { action: "acceptInvitation", role: "user" } }];

const allPhases = {
  "1_track_table": trackTableArgs,
  "2_relationships": relationshipArgs,
  "3_permissions": permissionArgs,
  "4a_custom_types": actionSetupArgs,
  "4b_create_action": createActionArgs,
  "4c_action_permission": actionPermissionArgs,
};

if (mode === "plan") {
  console.log("PLAN — nothing will be sent. Re-run with --apply to execute.\n");
  console.log(
    "IMPORTANT: phase 4a (set_custom_types) REPLACES the entire custom\n" +
      "types list — it re-declares TriggerWorkflowRunOutput and\n" +
      "ApproveStepOutput alongside the new AcceptInvitationOutput so\n" +
      "nothing existing is dropped. Verified against current server state\n" +
      "is NOT checked automatically here — if you've added other custom\n" +
      "types since, update this list first.\n"
  );
  for (const [phase, args] of Object.entries(allPhases)) {
    console.log(`${phase}: ${args.length} operation(s)`);
    for (const a of args) {
      console.log(`  - ${a.type}`);
    }
  }
  process.exit(0);
}

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

async function verifyTableTracked() {
  const exported = await exportMetadata();
  const source = (exported.sources || []).find((s) => s.name === "default") || exported.sources?.[0];
  const found = (source?.tables || []).some((t) => t.table.schema === "public" && t.table.name === "org_invitations");
  if (!found) throw new Error("org_invitations not found in tracked tables after apply");
  return "org_invitations tracked";
}

async function verifyRelationship() {
  const exported = await exportMetadata();
  const source = (exported.sources || []).find((s) => s.name === "default") || exported.sources?.[0];
  const table = (source?.tables || []).find((t) => t.table.name === "org_invitations");
  const hasRel = table?.object_relationships?.some((r) => r.name === "organization");
  if (!hasRel) throw new Error("org_invitations.organization relationship not found after apply");
  return "organization relationship present";
}

async function verifyPermissions() {
  const exported = await exportMetadata();
  const source = (exported.sources || []).find((s) => s.name === "default") || exported.sources?.[0];
  const table = (source?.tables || []).find((t) => t.table.name === "org_invitations");
  const hasSelect = table?.select_permissions?.some((p) => p.role === "user");
  const hasInsert = table?.insert_permissions?.some((p) => p.role === "user");
  if (!hasSelect || !hasInsert) throw new Error("org_invitations select/insert permission for role user not found");
  return "select + insert permissions present";
}

async function verifyCustomTypes() {
  const exported = await exportMetadata();
  const names = (exported.custom_types?.objects || []).map((o) => o.name);
  const missing = ["TriggerWorkflowRunOutput", "ApproveStepOutput", "AcceptInvitationOutput"].filter(
    (n) => !names.includes(n)
  );
  if (missing.length) throw new Error("missing custom types: " + missing.join(", "));
  return `custom types present: ${names.join(", ")}`;
}

async function verifyAction() {
  const exported = await exportMetadata();
  const action = (exported.actions || []).find((a) => a.name === "acceptInvitation");
  if (!action) throw new Error("acceptInvitation action not found after apply");
  return `acceptInvitation handler: ${action.definition.handler}`;
}

async function verifyActionPermission() {
  const exported = await exportMetadata();
  const action = (exported.actions || []).find((a) => a.name === "acceptInvitation");
  const hasRole = action?.permissions?.some((p) => p.role === "user");
  if (!hasRole) throw new Error("acceptInvitation missing permission for role user");
  return "acceptInvitation permitted for role=user";
}

const phaseSequence = [
  { name: "1_track_table", args: allPhases["1_track_table"], verify: verifyTableTracked },
  { name: "2_relationships", args: allPhases["2_relationships"], verify: verifyRelationship },
  { name: "3_permissions", args: allPhases["3_permissions"], verify: verifyPermissions },
  { name: "4a_custom_types", args: allPhases["4a_custom_types"], verify: verifyCustomTypes },
  { name: "4b_create_action", args: allPhases["4b_create_action"], verify: verifyAction },
  { name: "4c_action_permission", args: allPhases["4c_action_permission"], verify: verifyActionPermission },
];

console.log(`Applying ${phaseSequence.length} phases sequentially against ${hasuraUrl}\n`);

for (const phase of phaseSequence) {
  console.log(`--- Phase: ${phase.name} (${phase.args.length} operation(s)) ---`);
  const { ok, json } = await callMetadataApi({ type: "bulk", args: phase.args });

  if (!ok) {
    console.error(`✗ FAILED at phase "${phase.name}". Stopping here.`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`  bulk call succeeded`);

  try {
    const result = await phase.verify();
    console.log(`  ✓ verified: ${result}`);
  } catch (err) {
    console.error(`✗ FAILED at phase "${phase.name}" verification. Stopping here.`);
    console.error(err.message);
    process.exit(1);
  }
  console.log("");
}

console.log("All phases applied and independently verified against the live server.");
