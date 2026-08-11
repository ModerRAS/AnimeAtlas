import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = findRoot(process.cwd());
const refresh = process.argv.includes("--refresh");
const rows = readdirSync(join(root, "db", "media"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const media = readJson(join(root, "db", "media", name));
    const aliases = readJson(join(root, "db", "aliases", name));
    const metadata = readJson(join(root, "db", "metadata", name));
    const subject = media.provider_refs.find((ref) => ref.provider === "bangumi" && ref.entity === "subject");
    return { media, aliases, metadata, subject };
  })
  .filter((row) => row.media.schema === "media-identity/v1");

const audited = await pool(rows, 3, async (row) => {
  const subjectId = String(row.subject?.id ?? "");
  if (!subjectId) return result(row, { classification: "missing-provider-ref" });
  const subject = await cachedRequest(`subject-${subjectId}.json`, `/v0/subjects/${subjectId}`);
  if (subject?._status === 404) return result(row, { classification: "subject-404", subject_id: subjectId });
  if (!subject || subject._status) {
    return result(row, { classification: "subject-error", subject_id: subjectId, status: subject?._status });
  }
  const relations = await cachedRequest(`relations-${subjectId}.json`, `/v0/subjects/${subjectId}/subjects`);
  const episodes = subject.type === 2 || subject.type === 6 ? await cachedEpisodes(subjectId) : { total: 0, data: [] };
  const localTitles = [row.metadata.metadata.title, ...row.aliases.aliases.map((alias) => alias.value)];
  const liveTitles = [subject.name, subject.name_cn].filter(Boolean);
  const animeRelations = Array.isArray(relations)
    ? relations
        .filter((related) => related.type === 2)
        .map((related) => ({ id: String(related.id), relation: related.relation, name: related.name, name_cn: related.name_cn }))
    : [];
  return result(row, {
    classification: subject.type === 2 ? "anime" : `bangumi-type-${subject.type}`,
    subject_id: subjectId,
    subject: {
      type: subject.type,
      name: subject.name,
      name_cn: subject.name_cn,
      date: subject.date,
      eps: subject.eps,
      platform: subject.platform
    },
    title_match: localTitles.some((local) => liveTitles.some((live) => normalize(local) === normalize(live))),
    explicit_installment: parseInstallment(`${subject.name ?? ""} ${subject.name_cn ?? ""} ${row.metadata.metadata.title ?? ""}`),
    anime_relations: animeRelations,
    regular_episodes: episodes.data.filter((episode) => episode.type === 0).length
  });
});

const summary = audited.reduce((counts, item) => {
  counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  return counts;
}, {});
const report = {
  schema: "animeatlas-v2-migration-audit/v1",
  observed_at: new Date().toISOString(),
  source: {
    provider: "bangumi",
    raw_directory: "raw/bangumi/api",
    filesystem_traversed: false,
    library_database_modified: false
  },
  summary: { total: audited.length, ...summary },
  media: audited
};
const reportPath = join(root, "reports", "v2-migration-audit.json");
mkdirSync(dirname(reportPath), { recursive: true });
writeJson(reportPath, report);
console.log(JSON.stringify(report.summary));
console.log(`Wrote ${reportPath}`);

function result(row, extra) {
  return {
    media_id: row.media.id,
    local_title: row.metadata.metadata.title,
    aliases: row.aliases.aliases.map((alias) => alias.value),
    ...extra
  };
}

async function cachedEpisodes(subjectId) {
  const file = join(root, "raw", "bangumi", "api", `episodes-${subjectId}.json`);
  if (!refresh && existsSync(file)) return readJson(file);
  const first = await request(`/v0/episodes?subject_id=${subjectId}&type=0&limit=100&offset=0`);
  if (first._status) return first;
  const data = [...first.data];
  for (let offset = 100; offset < first.total; offset += 100) {
    const page = await request(`/v0/episodes?subject_id=${subjectId}&type=0&limit=100&offset=${offset}`);
    if (page._status) return page;
    data.push(...page.data);
  }
  const combined = { total: first.total, limit: Math.max(first.total, 100), offset: 0, data };
  writeJson(file, combined);
  return combined;
}

async function cachedRequest(fileName, pathname) {
  const file = join(root, "raw", "bangumi", "api", fileName);
  if (!refresh && existsSync(file)) return readJson(file);
  const value = await request(pathname);
  writeJson(file, value);
  return value;
}

async function request(pathname) {
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await fetch(`https://api.bgm.tv${pathname}`, {
        headers: { accept: "application/json", "user-agent": "AnimeAtlas v2 migration audit (https://github.com/ModerRAS/AnimeAtlas)" }
      });
      if (response.ok) return response.json();
      if (response.status === 404) return { _status: 404 };
      if (response.status < 429 && response.status < 500) return { _status: response.status };
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 750));
  }
  throw new Error(`Bangumi ${pathname} failed: ${response?.status ?? "network"} ${response?.statusText ?? String(lastError)}`);
}

async function pool(items, concurrency, fn) {
  let index = 0;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      output[current] = await fn(items[current]);
    }
  }));
  return output;
}

function parseInstallment(value) {
  const season = firstNumber(value, [
    /(?:season|s)\s*0*(\d+)/i,
    /0*(\d+)(?:st|nd|rd|th)\s*season/i,
    /第\s*0*(\d+)\s*(?:季|期)/u
  ]);
  return season === undefined ? {} : { season };
}

function firstNumber(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function findRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
}
