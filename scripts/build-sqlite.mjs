import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = findRepoRoot();
const outPath = resolve(root, process.argv.slice(2).find((arg) => arg !== "--") ?? "release/animeatlas.sqlite");
const version = process.env.RELEASE_VERSION ?? "dev";

mkdirSync(dirname(outPath), { recursive: true });
rmSync(outPath, { force: true });
execFileSync("sqlite3", [outPath], { input: buildSql(), encoding: "utf8" });
console.log(`Built ${outPath}`);

function buildSql() {
  const mediaRecords = readJsonFiles("db/media");
  const aliasRecords = new Map(readJsonFiles("db/aliases").map((record) => [record.media_id, record]));
  const metadataRecords = new Map(readJsonFiles("db/metadata").map((record) => [record.media_id, record]));
  const searchIndex = readJson("generated/indexes/search/tokens.json");
  const stats = readJson("generated/stats/summary.json");
  const buildManifest = readJson("generated/manifests/build.json");
  const lines = [
    "PRAGMA foreign_keys = ON;",
    "BEGIN;",
    "CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, summary TEXT, metadata_json TEXT NOT NULL, provenance_json TEXT NOT NULL);",
    "CREATE TABLE aliases (media_id TEXT NOT NULL REFERENCES media(id), value TEXT NOT NULL, normalized TEXT NOT NULL, language TEXT, type TEXT, source TEXT, confidence REAL, PRIMARY KEY (media_id, value));",
    "CREATE INDEX aliases_normalized_idx ON aliases(normalized);",
    "CREATE TABLE provider_refs (media_id TEXT NOT NULL REFERENCES media(id), provider TEXT NOT NULL, entity TEXT NOT NULL, provider_id TEXT NOT NULL, provider_key TEXT NOT NULL UNIQUE);",
    "CREATE INDEX provider_refs_lookup_idx ON provider_refs(provider, entity, provider_id);",
    "CREATE TABLE search_tokens (token TEXT NOT NULL, media_id TEXT NOT NULL REFERENCES media(id), PRIMARY KEY (token, media_id));",
    "CREATE INDEX search_tokens_token_idx ON search_tokens(token);",
    "CREATE TABLE release_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
  ];

  for (const identity of mediaRecords) {
    const aliases = aliasRecords.get(identity.id);
    const metadata = metadataRecords.get(identity.id);
    if (!metadata) {
      throw new Error(`Missing metadata for ${identity.id}`);
    }
    const normalized = metadata.metadata ?? {};
    lines.push(insert("media", {
      id: identity.id,
      kind: identity.kind,
      title: stringOrNull(normalized.title),
      summary: stringOrNull(normalized.summary),
      metadata_json: JSON.stringify(normalized),
      provenance_json: JSON.stringify(metadata._meta ?? {})
    }));

    for (const alias of aliases?.aliases ?? []) {
      lines.push(insert("aliases", {
        media_id: identity.id,
        value: alias.value,
        normalized: normalizeAlias(alias.value),
        language: alias.language ?? null,
        type: alias.type ?? null,
        source: alias.source ?? null,
        confidence: alias.confidence ?? null
      }));
    }

    for (const ref of identity.provider_refs ?? []) {
      lines.push(insert("provider_refs", {
        media_id: identity.id,
        provider: ref.provider,
        entity: ref.entity,
        provider_id: ref.id,
        provider_key: `${identity.kind}:${ref.provider}:${ref.entity}:${ref.id}`
      }));
    }
  }

  for (const [token, mediaIds] of Object.entries(searchIndex.entries ?? {})) {
    for (const mediaId of mediaIds) {
      lines.push(insert("search_tokens", { token, media_id: mediaId }));
    }
  }

  lines.push(insert("release_info", { key: "schema", value: "animeatlas-sqlite/v1" }));
  lines.push(insert("release_info", { key: "version", value: version }));
  lines.push(insert("release_info", { key: "stats", value: JSON.stringify(stats) }));
  lines.push(insert("release_info", { key: "build_manifest", value: JSON.stringify(buildManifest) }));
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

function insert(table, values) {
  const columns = Object.keys(values);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => sql(values[column])).join(", ")});`;
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeAlias(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readJsonFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readJson(join(dir, entry.name)));
}

function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
}
