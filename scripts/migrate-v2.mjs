import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = findRoot(process.cwd());
const write = process.argv.includes("--write");
const refresh = process.argv.includes("--refresh");
const planDirectory = join(root, "db", "migrations");
const plans = readdirSync(planDirectory)
  .filter((name) => /^v2-.*\.json$/.test(name))
  .sort()
  .map((name) => readJson(join(planDirectory, name)));
const seriesPlans = plans.flatMap((plan) => plan.series.map((series) => ({ ...series, observed_at: plan.observed_at })));
const episodeIds = existingEpisodeIds(root);
let nextEpisodeId = Math.max(0, ...[...episodeIds.values()].map((id) => Number(id.slice(8)))) + 1;
let mediaCount = 0;
let episodeCount = 0;

for (const series of seriesPlans) {
  assert(/^series-\d{6}$/.test(series.id), `Invalid series id ${series.id}`);
  assert(series.media.length > 0, `${series.id} has no media`);
  if (write) {
    writeJson(join(root, "db", "series", `${series.id}.json`), {
      $schema: "../../packages/schema/schemas/series-identity.schema.json",
      schema: "series-identity/v2",
      id: series.id,
      kind: "anime-series",
      title: series.title,
      relationships: []
    });
    writeJson(join(root, "db", "series-aliases", `${series.id}.json`), {
      $schema: "../../packages/schema/schemas/series-aliases.schema.json",
      schema: "series-aliases/v2",
      series_id: series.id,
      aliases: series.aliases
    });
  }

  for (const item of series.media) {
    const mediaPath = join(root, "db", "media", `${item.id}.json`);
    const aliasesPath = join(root, "db", "aliases", `${item.id}.json`);
    const metadataPath = join(root, "db", "metadata", `${item.id}.json`);
    const media = readJson(mediaPath);
    const aliases = readJson(aliasesPath);
    const metadata = readJson(metadataPath);
    const subjectRef = media.provider_refs.find((ref) => ref.provider === "bangumi" && ref.entity === "subject");
    assert(subjectRef, `${item.id} has no Bangumi subject ref`);
    const subject = item.evidence_only ? undefined : await cachedApi(`subject-${subjectRef.id}.json`, `/v0/subjects/${subjectRef.id}`);
    if (subject) {
      const allowedTypes = item.allowed_subject_types ?? [2];
      assert(allowedTypes.includes(subject.type), `${item.id} Bangumi subject ${subjectRef.id} has disallowed type ${subject.type}`);
      assert(titleMatches(subject, metadata, aliases), `${item.id} title does not match Bangumi subject ${subjectRef.id}`);
    }
    const installment = item.installment ?? (item.season === undefined ? {} : { season: item.season });
    for (const key of ["season", "part", "cour"]) {
      assert(installment[key] === undefined || (Number.isInteger(installment[key]) && installment[key] > 0), `${item.id} has invalid ${key}`);
    }
    const enrichedAliases = [...aliases.aliases];
    for (const candidate of subject ? [
      { value: subject.name, language: "ja", type: "official", source: "bangumi", confidence: 0.98 },
      { value: subject.name_cn, language: "zh-Hans", type: "localized", source: "bangumi", confidence: 0.98 }
    ] : [
      { value: metadata.metadata.title, language: "ja", type: "official", source: "catalog-evidence", confidence: 0.9 }
    ]) {
      if (candidate.value && !enrichedAliases.some((alias) => normalize(alias.value) === normalize(candidate.value))) {
        enrichedAliases.push(candidate);
      }
    }

    if (write) {
      writeJson(mediaPath, {
        $schema: "../../packages/schema/schemas/media-identity.schema.json",
        schema: "media-identity/v2",
        id: media.id,
        kind: media.kind,
        series_id: series.id,
        title: metadata.metadata.title,
        installment,
        provider_refs: media.provider_refs,
        relationships: item.relationships ?? media.relationships
      });
      writeJson(aliasesPath, { ...aliases, schema: "media-aliases/v2", aliases: enrichedAliases });
    }

    const response = subject ? await cachedApi(
      `episodes-${subjectRef.id}.json`,
      `/v0/episodes?subject_id=${subjectRef.id}&type=0&limit=100&offset=0`
    ) : { total: 0, data: [] };
    assert(Array.isArray(response.data), `Bangumi episodes for ${subjectRef.id} have no data array`);
    assert(response.data.length >= response.total, `Bangumi episode cache for ${subjectRef.id} is incomplete: ${response.data.length}/${response.total}`);
    const episodes = response.data
      .filter((episode) => episode.type === 0 && String(episode.subject_id) === String(subjectRef.id))
      .sort((left, right) => Number(left.sort) - Number(right.sort) || Number(left.ep) - Number(right.ep));
    const records = episodes.map((episode) => {
      const providerId = String(episode.id);
      let id = episodeIds.get(providerId);
      if (!id) {
        id = `episode-${String(nextEpisodeId).padStart(6, "0")}`;
        nextEpisodeId += 1;
        episodeIds.set(providerId, id);
      }
      const numbers = [];
      if (Number.isInteger(episode.ep)) numbers.push({ namespace: "bangumi:ep", value: episode.ep, source: "bangumi" });
      if (Number.isInteger(episode.sort)) numbers.push({ namespace: "bangumi:sort", value: episode.sort, source: "bangumi" });
      assert(numbers.length > 0, `Bangumi episode ${providerId} has no integer ep or sort`);
      return {
        id,
        kind: "regular",
        provider_refs: [{ provider: "bangumi", entity: "episode", id: providerId }],
        numbers,
        provenance: {
          source: "bangumi",
          observed_at: series.observed_at,
          raw_ref: `raw/bangumi/api/episodes-${subjectRef.id}.json`
        }
      };
    });
    if (write) {
      writeJson(join(root, "db", "episodes", `${item.id}.json`), {
        $schema: "../../packages/schema/schemas/episode-record.schema.json",
        schema: "episode-record/v2",
        media_id: item.id,
        episodes: records
      });
      if (subject && Number.isInteger(subject.eps) && subject.eps > 0) {
        metadata.metadata.episode_count = subject.eps;
        metadata._meta.last_sync.bangumi = series.observed_at;
        metadata._meta.fields["metadata.episode_count"] = {
          source: "bangumi",
          source_field: "eps",
          last_sync: series.observed_at,
          rule: "bangumi.eps -> metadata.episode_count",
          provider_ref: subjectRef,
          raw_ref: `raw/bangumi/api/subject-${subjectRef.id}.json`
        };
        writeJson(metadataPath, metadata);
      }
    }
    mediaCount += 1;
    episodeCount += records.length;
  }
}

console.log(JSON.stringify({ schema: "v2-migration-plan-set/v1", write, refresh, plans: plans.length, series: seriesPlans.length, media: mediaCount, episodes: episodeCount }));

async function cachedApi(fileName, pathname) {
  const file = join(root, "raw", "bangumi", "api", fileName);
  if (!refresh && existsSync(file)) return readJson(file);
  const url = `https://api.bgm.tv${pathname}`;
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "AnimeAtlas v2 migration (https://github.com/ModerRAS/AnimeAtlas)" }
      });
      if (response.ok || (response.status < 429 && response.status < 500)) break;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 750));
  }
  assert(response?.ok, `Bangumi ${pathname} failed: ${response?.status ?? "network"} ${response?.statusText ?? String(lastError)}`);
  const value = await response.json();
  mkdirSync(join(root, "raw", "bangumi", "api"), { recursive: true });
  writeJson(file, value);
  return value;
}

function titleMatches(subject, metadata, aliases) {
  const local = [metadata.metadata.title, ...aliases.aliases.map((alias) => alias.value)].map(normalize);
  return [subject.name, subject.name_cn].filter(Boolean).map(normalize).some((title) => local.includes(title));
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function existingEpisodeIds(repoRoot) {
  const result = new Map();
  const directory = join(repoRoot, "db", "episodes");
  if (!existsSync(directory)) return result;
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    for (const episode of readJson(join(directory, file)).episodes) {
      const ref = episode.provider_refs.find((value) => value.provider === "bangumi" && value.entity === "episode");
      if (ref) result.set(String(ref.id), episode.id);
    }
  }
  return result;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
}
