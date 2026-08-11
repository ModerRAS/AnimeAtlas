import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = findRepoRoot();
const outPath = resolve(root, process.argv.slice(2).find((arg) => arg !== "--") ?? "release/animeatlas.sqlite");
const version = process.env.RELEASE_VERSION ?? "dev";
const parserModel = "ModerRAS/AniFileBERT";
const parserRevision = "d8ddb0b54dad4d65a60ab7eba5acb06a2a1fab02";

mkdirSync(dirname(outPath), { recursive: true });
rmSync(outPath, { force: true });
execFileSync("sqlite3", [outPath], { input: buildSql(), encoding: "utf8" });
const integrity = execFileSync("sqlite3", [outPath, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
if (integrity !== "ok") throw new Error(`SQLite integrity_check failed: ${integrity}`);

const safeVersion = version.replace(/[^A-Za-z0-9._+-]/g, "-");
const immutablePath = join(dirname(outPath), `animeatlas-${safeVersion}.sqlite`);
if (resolve(immutablePath) !== resolve(outPath)) copyFileSync(outPath, immutablePath);
const manifestPath = join(dirname(outPath), "manifest.json");
const immutableManifestPath = join(dirname(outPath), `animeatlas-${safeVersion}.manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify({
  schema: "animeatlas-release-manifest/v2",
  version,
  artifact: basename(outPath),
  immutable_artifact: basename(immutablePath),
  bytes: statSync(outPath).size,
  sha256: createHash("sha256").update(readFileSync(outPath)).digest("hex"),
  sqlite_schema: "animeatlas-sqlite/v2",
  contribution_schema: "contribution/v2",
  normalization: "unicode-nfkc-lower/v1",
  generator: "@animeatlas/generator@0.0.0",
  parser: { model: parserModel, revision: parserRevision, label_schema: 2 }
}, null, 2)}\n`);
copyFileSync(manifestPath, immutableManifestPath);
console.log(`Built ${outPath}, ${immutablePath}, ${manifestPath}, and ${immutableManifestPath}`);

function buildSql() {
  const seriesRecords = readJsonFiles("db/series");
  const seriesAliasRecords = readJsonFiles("db/series-aliases");
  const mediaRecords = readJsonFiles("db/media");
  const aliasRecords = new Map(readJsonFiles("db/aliases").map((record) => [record.media_id, record]));
  const episodeRecords = readJsonFiles("db/episodes");
  const metadataRecords = new Map(readJsonFiles("db/metadata").map((record) => [record.media_id, record]));
  const searchIndex = readJson("generated/indexes/search/tokens.json");
  const stats = readJson("generated/stats/summary.json");
  const buildManifest = readJson("generated/manifests/build.json");
  const lines = [
    "PRAGMA foreign_keys = ON;",
    "BEGIN;",
    "CREATE TABLE series (id TEXT PRIMARY KEY, title TEXT NOT NULL, relationships_json TEXT NOT NULL);",
    "CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, series_id TEXT REFERENCES series(id), title TEXT, season_number INTEGER, part_number INTEGER, cour_number INTEGER, summary TEXT, metadata_json TEXT NOT NULL, provenance_json TEXT NOT NULL);",
    "CREATE INDEX media_series_installment_idx ON media(series_id, season_number, part_number, cour_number);",
    "CREATE TABLE series_aliases (series_id TEXT NOT NULL REFERENCES series(id), value TEXT NOT NULL, normalized TEXT NOT NULL, language TEXT, type TEXT, source TEXT, confidence REAL, PRIMARY KEY (series_id, value));",
    "CREATE INDEX series_aliases_normalized_idx ON series_aliases(normalized);",
    "CREATE TABLE aliases (media_id TEXT NOT NULL REFERENCES media(id), value TEXT NOT NULL, normalized TEXT NOT NULL, language TEXT, type TEXT, source TEXT, confidence REAL, PRIMARY KEY (media_id, value));",
    "CREATE INDEX aliases_normalized_idx ON aliases(normalized);",
    "CREATE VIEW aliases_v1_compat AS SELECT a.* FROM aliases a JOIN (SELECT normalized FROM aliases GROUP BY normalized HAVING COUNT(DISTINCT media_id) = 1) u ON u.normalized = a.normalized;",
    "CREATE TABLE provider_refs (media_id TEXT NOT NULL REFERENCES media(id), provider TEXT NOT NULL, entity TEXT NOT NULL, provider_id TEXT NOT NULL, provider_key TEXT NOT NULL UNIQUE);",
    "CREATE INDEX provider_refs_lookup_idx ON provider_refs(provider, entity, provider_id);",
    "CREATE TABLE episodes (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id), kind TEXT NOT NULL, provenance_json TEXT NOT NULL);",
    "CREATE INDEX episodes_media_idx ON episodes(media_id);",
    "CREATE TABLE episode_provider_refs (episode_id TEXT NOT NULL REFERENCES episodes(id), provider TEXT NOT NULL, entity TEXT NOT NULL, provider_id TEXT NOT NULL, PRIMARY KEY (provider, entity, provider_id));",
    "CREATE TABLE episode_numbers (episode_id TEXT NOT NULL REFERENCES episodes(id), namespace TEXT NOT NULL, number_value INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (episode_id, namespace, number_value, source));",
    "CREATE INDEX episode_numbers_lookup_idx ON episode_numbers(namespace, number_value, episode_id);",
    "CREATE TABLE search_tokens (token TEXT NOT NULL, media_id TEXT NOT NULL REFERENCES media(id), PRIMARY KEY (token, media_id));",
    "CREATE INDEX search_tokens_token_idx ON search_tokens(token);",
    "CREATE TABLE release_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
  ];

  for (const series of seriesRecords) {
    lines.push(insert("series", {
      id: series.id,
      title: series.title,
      relationships_json: JSON.stringify(series.relationships ?? [])
    }));
  }

  for (const record of seriesAliasRecords) {
    for (const alias of record.aliases ?? []) {
      lines.push(insert("series_aliases", {
        series_id: record.series_id,
        value: alias.value,
        normalized: normalizeAlias(alias.value),
        language: alias.language ?? null,
        type: alias.type ?? null,
        source: alias.source ?? null,
        confidence: alias.confidence ?? null
      }));
    }
  }

  for (const identity of mediaRecords) {
    const aliases = aliasRecords.get(identity.id);
    const metadata = metadataRecords.get(identity.id);
    if (!metadata) throw new Error(`Missing metadata for ${identity.id}`);
    const normalized = metadata.metadata ?? {};
    lines.push(insert("media", {
      id: identity.id,
      kind: identity.kind,
      series_id: identity.series_id ?? null,
      title: stringOrNull(identity.title) ?? stringOrNull(normalized.title),
      season_number: identity.installment?.season ?? null,
      part_number: identity.installment?.part ?? null,
      cour_number: identity.installment?.cour ?? null,
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

  for (const record of episodeRecords) {
    for (const episode of record.episodes ?? []) {
      lines.push(insert("episodes", {
        id: episode.id,
        media_id: record.media_id,
        kind: episode.kind,
        provenance_json: JSON.stringify(episode.provenance ?? {})
      }));
      for (const ref of episode.provider_refs ?? []) {
        lines.push(insert("episode_provider_refs", {
          episode_id: episode.id,
          provider: ref.provider,
          entity: ref.entity,
          provider_id: ref.id
        }));
      }
      for (const number of episode.numbers ?? []) {
        lines.push(insert("episode_numbers", {
          episode_id: episode.id,
          namespace: number.namespace,
          number_value: number.value,
          source: number.source
        }));
      }
    }
  }

  for (const [token, mediaIds] of Object.entries(searchIndex.entries ?? {})) {
    for (const mediaId of mediaIds) lines.push(insert("search_tokens", { token, media_id: mediaId }));
  }

  const releaseInfo = {
    schema: "animeatlas-sqlite/v2",
    catalog_version: version,
    contribution_schema: "contribution/v2",
    normalization_version: "unicode-nfkc-lower/v1",
    generator_version: "@animeatlas/generator@0.0.0",
    parser_model: parserModel,
    parser_revision: parserRevision,
    parser_label_schema: "2",
    stats: JSON.stringify(stats),
    build_manifest: JSON.stringify(buildManifest)
  };
  for (const [key, value] of Object.entries(releaseInfo)) lines.push(insert("release_info", { key, value }));
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
  const path = join(root, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
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
