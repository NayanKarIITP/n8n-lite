// scripts/apply-migrations.mjs
//
// Applies db/migrations/*.sql WITHOUT a direct Postgres connection string.
// Hasura exposes a schema/SQL execution endpoint (`/v2/query`, type
// "run_sql") that runs arbitrary SQL against its tracked "default"
// database using only the admin secret over HTTPS — the same secret you
// already use for every admin GraphQL call in this app. That's all this
// script uses.
//
// Why not `psql "$DATABASE_URL"`: Nhost's managed Postgres is not
// reachable directly unless you deliberately expose it (Nhost's dashboard
// has a "Enable public access" toggle for exactly this). This app never
// asks you to flip that on — Hasura's admin API already has everything it
// needs to run schema migrations without opening the database to the
// internet, so we use that instead. There is no code in this repository
// that opens a direct `pg` connection.
//
// Requires:
//   NHOST_HASURA_URL     e.g. https://<subdomain>.hasura.<region>.nhost.run
//                        (the Hasura base URL — NOT the /v1/graphql path)
//   NHOST_ADMIN_SECRET   your project's Hasura admin secret
//
// Usage: npm run migrate

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

const hasuraUrl = process.env.NHOST_HASURA_URL || process.env.HASURA_GRAPHQL_ENDPOINT;
const adminSecret = process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET;

if (!hasuraUrl || !adminSecret) {
  console.error(
    "Missing NHOST_HASURA_URL / NHOST_ADMIN_SECRET (or HASURA_GRAPHQL_ENDPOINT / " +
      "HASURA_GRAPHQL_ADMIN_SECRET as a fallback — the /v1/graphql suffix, if present, " +
      "is stripped automatically below). These are the only two values this script " +
      "needs — no database connection string required. See README 'Local setup'."
  );
  process.exit(1);
}

// Normalize: strip a trailing /v1/graphql if someone pastes the GraphQL
// endpoint here by mistake; we need the Hasura base URL for /v2/query.
const base = hasuraUrl.replace(/\/v1\/graphql\/?$/, "").replace(/\/$/, "");

async function runSql(sql, migrationName) {
  const res = await fetch(`${base}/v2/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": adminSecret,
    },
    body: JSON.stringify({
      type: "run_sql",
      args: {
        source: "default",
        sql,
        cascade: false,
        read_only: false,
      },
    }),
  });

  const json = await res.json();
  if (!res.ok || json.error) {
    console.error(`✗ ${migrationName} FAILED:`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`✓ ${migrationName} applied`);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("No migration files found in db/migrations/");
  process.exit(0);
}

console.log(`Applying ${files.length} migration(s) via ${base}/v2/query ...`);
for (const file of files) {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  await runSql(sql, file);
}
console.log("All migrations applied.");
