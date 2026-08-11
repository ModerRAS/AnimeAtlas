import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, win32 } from "node:path";

const root = findRepoRoot();
const libraryDb = resolve(process.env.LIBRARY_DB ?? "S:/动漫/library.db");
const outPath = resolve(root, process.argv[2] ?? "reports/library-replay-v2.json");
if (!existsSync(libraryDb)) throw new Error(`Library database does not exist: ${libraryDb}`);

const rows = readLibraryRows(libraryDb);
const v1Aliases = readJson("generated/indexes/aliases/exact.json").entries ?? {};
const v2Aliases = readJson("generated/indexes/aliases/candidates.json").entries ?? {};
const mediaContext = new Map(
  listMediaRecords().map((media) => [media.id, {
    season: media.installment?.season,
    bangumi: media.provider_refs?.find((ref) => ref.provider === "bangumi" && ref.entity === "subject")?.id
  }])
);
const mediaEpisodeNumbers = new Map(
  listEpisodeRecords().map((record) => [
    record.media_id,
    new Set(record.episodes.flatMap((episode) => episode.numbers.map((number) => number.value)))
  ])
);

const outcomes = [];
const counts = {
  rows: rows.length,
  v1_resolved: 0,
  v1_correct: 0,
  v2_resolved: 0,
  v2_correct: 0,
  v2_ambiguous: 0,
  season_conflicts: 0,
  changed: 0
};

for (const row of rows) {
  const titles = pathTitleCandidates(row.path);
  const v1Candidates = unique(titles.flatMap((title) => {
    const mediaId = v1Aliases[normalizeAlias(title)];
    return mediaId ? [mediaId] : [];
  }));
  const v2RawCandidates = unique(titles.flatMap((title) => v2Aliases[normalizeAlias(title)] ?? []));
  const seasonConflicts = v2RawCandidates.filter((mediaId) => {
    const catalogSeason = mediaContext.get(mediaId)?.season;
    return catalogSeason !== undefined && catalogSeason !== row.season;
  });
  const seasonCandidates = v2RawCandidates
    .filter((mediaId) => {
      const catalogSeason = mediaContext.get(mediaId)?.season;
      return catalogSeason === undefined || catalogSeason === row.season;
    });
  const episodeCandidates = seasonCandidates.filter((mediaId) => mediaEpisodeNumbers.get(mediaId)?.has(row.episode));
  const v2Candidates = episodeCandidates.length === 1 ? episodeCandidates : seasonCandidates;

  const seasonConflict = v2Candidates.length === 0 && seasonConflicts.length > 0;
  const v1 = resolution(v1Candidates);
  let v2 = resolution(v2Candidates);
  if (seasonConflict && v2RawCandidates.length === 1) {
    v2 = { ...resolution(v2RawCandidates), season_conflict: true };
  }
  const expectedBangumi = row.bangumi_id;
  const v1Correct = v1.status === "resolved" && mediaContext.get(v1.media_id)?.bangumi === expectedBangumi;
  const v2Correct = v2.status === "resolved" && mediaContext.get(v2.media_id)?.bangumi === expectedBangumi;
  if (v1.status === "resolved") counts.v1_resolved += 1;
  if (v1Correct) counts.v1_correct += 1;
  if (v2.status === "resolved") counts.v2_resolved += 1;
  if (v2Correct) counts.v2_correct += 1;
  if (v2.status === "ambiguous") counts.v2_ambiguous += 1;
  if (seasonConflict) counts.season_conflicts += 1;
  if (JSON.stringify(v1) !== JSON.stringify(v2)) counts.changed += 1;

  if (JSON.stringify(v1) !== JSON.stringify(v2) || seasonConflict || (!v2Correct && expectedBangumi)) {
    outcomes.push({
      path: row.path,
      library: {
        series_id: row.series_id,
        title: row.title,
        original_title: row.original_title,
        season: row.season,
        episode: row.episode,
        bangumi_id: expectedBangumi
      },
      title_candidates: titles,
      v1: { ...v1, correct: v1Correct },
      v2: { ...v2, correct: v2Correct, ...(seasonConflict ? { season_conflict: true } : {}) }
    });
  }
}

const report = {
  schema: "animeatlas-library-replay/v2",
  source: {
    database: libraryDb,
    sqlite_query_only: true,
    filesystem_traversed: false,
    path_source: "media_file.path"
  },
  counts,
  outcomes
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
console.log(JSON.stringify(counts));

function readLibraryRows(database) {
  const sql = `
    PRAGMA query_only=ON;
    SELECT json_group_array(json_object(
      'path', mf.path,
      'series_id', s.id,
      'title', s.title,
      'original_title', s.original_title,
      'season', e.season,
      'episode', e.episode,
      'bangumi_id', (SELECT value FROM series_external_id x WHERE x.series_id=s.id AND x.provider=1 ORDER BY value LIMIT 1)
    ))
    FROM media_file mf
    JOIN episode e ON e.id=mf.episode_id
    JOIN series s ON s.id=e.series_id;
  `;
  const output = execFileSync("sqlite3", [database, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  return JSON.parse(output || "[]");
}

function pathTitleCandidates(filePath) {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  const values = [];
  const filename = win32.basename(filePath).replace(/\.[^.]+$/, "");
  values.push(filename);
  values.push(filename.replace(/\s+-\s+\d+(?:\s*\([^)]*\))?.*$/u, "").trim());
  values.push(filename.replace(/[._]S\d{1,2}E\d{1,4}.*$/i, "").replace(/[._]+/g, " ").trim());
  for (const part of parts.slice(0, -1).reverse()) {
    if (/^(?:season|s)\s*\d+$/i.test(part)) continue;
    values.push(part);
  }
  return unique(values.filter((value) => value.length > 0));
}

function resolution(candidates) {
  if (candidates.length === 1) return { status: "resolved", media_id: candidates[0] };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unresolved" };
}

function normalizeAlias(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

function listMediaRecords() {
  return readdirSync(resolve(root, "db/media"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(root, "db/media", name), "utf8")));
}

function listEpisodeRecords() {
  return readdirSync(resolve(root, "db/episodes"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(root, "db/episodes", name), "utf8")));
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
}
