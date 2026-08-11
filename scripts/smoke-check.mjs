import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contributionFromIssueEvent, writeApprovedContributionRecord } from "../apps/github-action/dist/index.js";
import {
  applyRepositoryApprovedContributions,
  planRepositoryMediaImport
} from "../packages/importer/dist/index.js";
import {
  bangumiApiSubjectUrl,
  createBangumiApiProvider,
  createBangumiArchiveProviderFromFile
} from "../packages/provider-bangumi/dist/index.js";
import { validateRepository } from "../packages/validator/dist/index.js";

function runCliJson(args) {
  const output = execFileSync(process.execPath, ["apps/cli/dist/index.js", ...args], { encoding: "utf8" });
  return JSON.parse(output);
}

function copySeedRepo(target) {
  writeFileSync(join(target, "pnpm-workspace.yaml"), "packages: []\n");
  for (const dir of [
    "source/manifests",
    "source/contributions/approved",
    "db/series",
    "db/series-aliases",
    "db/media",
    "db/aliases",
    "db/metadata"
  ]) {
    mkdirSync(join(target, dir), { recursive: true });
  }
  copyFileSync("source/manifests/providers.json", join(target, "source/manifests/providers.json"));
  copyFileSync("db/series/series-000019.json", join(target, "db/series/series-000019.json"));
  copyFileSync("db/series-aliases/series-000019.json", join(target, "db/series-aliases/series-000019.json"));
  copyFileSync("db/media/media-000001.json", join(target, "db/media/media-000001.json"));
  copyFileSync("db/aliases/media-000001.json", join(target, "db/aliases/media-000001.json"));
  copyFileSync("db/metadata/media-000001.json", join(target, "db/metadata/media-000001.json"));
}

function copyV2SeedRepo(target) {
  writeFileSync(join(target, "pnpm-workspace.yaml"), "packages: []\n");
  for (const dir of [
    "source/manifests",
    "source/contributions/approved",
    "db/series",
    "db/series-aliases",
    "db/media",
    "db/aliases",
    "db/metadata",
    "db/episodes"
  ]) {
    mkdirSync(join(target, dir), { recursive: true });
  }
  for (const file of [
    "source/manifests/providers.json",
    "db/series/series-000001.json",
    "db/series-aliases/series-000001.json",
    "db/media/media-000007.json",
    "db/aliases/media-000007.json",
    "db/metadata/media-000007.json",
    "db/episodes/media-000007.json"
  ]) {
    copyFileSync(file, join(target, file));
  }
}

function issueEvent(operationType = "add_provider_ref") {
  const body = operationType === "create_media"
    ? [
        "### Change Type", "", "create_media", "",
        "### Canonical Title", "", "Gachiakuta", "",
        "### Alias Value", "", "Gachiakuta", "",
        "### Alias Language", "", "ja-Latn", "",
        "### Alias Type", "", "romaji", "",
        "### Provider", "", "bangumi", "",
        "### Provider Entity", "", "subject", "",
        "### Provider ID", "", "498947", "",
        "### Evidence URL", "", "https://bgm.tv/subject/498947"
      ].join("\n")
    : operationType === "add_alias"
      ? [
          "### Change Type", "", "add_alias", "",
          "### Media ID", "", "media-000001", "",
          "### Alias Value", "", "Frieren", "",
          "### Alias Language", "", "en", "",
          "### Alias Type", "", "alternative", "",
          "### Evidence URL", "", "https://example.test/source"
        ].join("\n")
      : [
          "### Change Type", "", "add_provider_ref", "",
          "### Media ID", "", "media-000001", "",
          "### Provider", "", "myanimelist", "",
          "### Provider Entity", "", "anime", "",
          "### Provider ID", "", "999999", "",
          "### Evidence URL", "", "https://example.test/myanimelist/999999"
        ].join("\n");

  return {
    action: "labeled",
    label: { name: "approved" },
    issue: {
      number: 42,
      html_url: "https://github.com/example/repo/issues/42",
      body,
      user: { login: "contributor" },
      updated_at: "2026-07-08T12:34:56Z"
    },
    sender: { login: "maintainer" }
  };
}

function v2IssueEvent(season = 4) {
  return {
    action: "labeled",
    label: { name: "approved" },
    issue: {
      number: 500,
      html_url: "https://github.com/example/repo/issues/500",
      body: [
        "### Name That Should Resolve", "", "Tensei Shitara Slime Datta Ken S4", "",
        "### Example Filename or Path", "", "Tensei Shitara Slime Datta Ken 4th Season - 06(78).mkv", "",
        "### Correct Anime", "", "https://bgm.tv/subject/515594", "",
        "### Season / Part", "", `Season ${season}`, "",
        "### Episode Mapping", "", "06(78)"
      ].join("\n"),
      user: { login: "contributor" },
      updated_at: "2026-08-10T00:00:00Z"
    },
    sender: { login: "maintainer" }
  };
}

const ambiguousFrieren = spawnSync(
  process.execPath,
  ["apps/cli/dist/index.js", "resolve", "alias", "Sousou no Frieren", "--compact"],
  { encoding: "utf8" }
);
assert.equal(ambiguousFrieren.status, 3);
assert.deepEqual(JSON.parse(ambiguousFrieren.stdout).candidates, ["media-000001", "media-000097"]);
const frierenSeason1 = runCliJson(["resolve", "alias", "Sousou no Frieren", "--season", "1", "--compact"]);
assert.equal(frierenSeason1.media_id, "media-000001");
assert.equal(frierenSeason1.metadata.title, "葬送的芙莉莲");
assert.equal(frierenSeason1.provenance.fields["metadata.title"].source, "bangumi");
assert.equal(runCliJson(["resolve", "alias", "Sousou no Frieren", "--season", "2", "--compact"]).media_id, "media-000097");

const ambiguousSeries = spawnSync(
  process.execPath,
  ["apps/cli/dist/index.js", "resolve", "alias", "彼女、お借りします", "--compact"],
  { encoding: "utf8" }
);
assert.equal(ambiguousSeries.status, 3);
assert.deepEqual(JSON.parse(ambiguousSeries.stdout).candidates, ["media-000013", "media-000075"]);
assert.equal(runCliJson(["resolve", "alias", "彼女、お借りします", "--season", "1", "--compact"]).media_id, "media-000075");
assert.equal(runCliJson(["resolve", "alias", "彼女、お借りします", "--season", "5", "--compact"]).media_id, "media-000013");

const providerResult = runCliJson(["resolve", "provider", "bangumi", "subject", "400602", "--compact"]);
assert.equal(providerResult.found, true);
assert.equal(providerResult.media_id, "media-000001");
assert.equal(providerResult.metadata.episode_count, 28);

const tmdbResult = runCliJson(["resolve", "provider", "tmdb", "tv", "217850", "--compact"]);
assert.equal(tmdbResult.found, true);
assert.equal(tmdbResult.media_id, "media-000001");

const anidbResult = runCliJson(["resolve", "provider", "anidb", "anime", "18199", "--compact"]);
assert.equal(anidbResult.found, true);
assert.equal(anidbResult.media_id, "media-000001");

const viewerData = JSON.parse(readFileSync("apps/viewer/dist/public/data.json", "utf8"));
const viewerHtml = readFileSync("apps/viewer/dist/public/index.html", "utf8");
assert.equal(viewerData.schema, "animeatlas-viewer-data/v1");
assert.equal(viewerData.media[0].id, "media-000001");
assert.equal(viewerHtml.includes("AnimeAtlas Viewer"), true);

const archiveDir = mkdtempSync(join(tmpdir(), "animeatlas-archive-"));
const archiveFile = join(archiveDir, "subjects.jsonl");
writeFileSync(
  archiveFile,
  [
    { id: 400602, type: 2, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", eps: 28, duration: "24m" },
    { id: 1, type: 1, name: "Not Anime" },
    { id: 999999, type: 2, name: "Example Anime", eps: 12, duration: "00:24:00" }
  ].map((row) => JSON.stringify(row)).join("\n") + "\n"
);
const archiveProvider = createBangumiArchiveProviderFromFile(archiveFile, { lastSync: "2026-07-08T12:34:56Z" });
const archivePlan = await planRepositoryMediaImport({ candidates: archiveProvider.bulkImport() });
assert.deepEqual(archivePlan.matches.map((item) => item.mediaId), ["media-000001"]);
assert.equal(archivePlan.creates.length, 1);
assert.equal(archivePlan.creates[0].candidate.providerRef.id, "999999");
assert.equal(archivePlan.creates[0].candidate.metadata.title, "Example Anime");
assert.equal(archivePlan.conflicts.length, 0);

const seenApiUrls = [];
const apiProvider = createBangumiApiProvider({
  subjectIds: [400602],
  baseUrl: "https://api.example.test",
  lastSync: "2026-07-08T12:34:56Z",
  fetchImpl: async (url, init) => {
    seenApiUrls.push({ url, headers: init?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { id: 400602, type: 2, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", eps: 28, duration: "24m" };
      }
    };
  }
});
const apiCandidates = [];
for await (const candidate of apiProvider.incrementalUpdate()) {
  apiCandidates.push(candidate);
}
assert.equal(seenApiUrls[0].url, "https://api.example.test/v0/subjects/400602");
assert.equal(bangumiApiSubjectUrl(400602, "https://api.example.test/"), "https://api.example.test/v0/subjects/400602");
assert.equal(apiCandidates.length, 1);
assert.equal(apiCandidates[0].providerRef.id, "400602");
assert.equal(apiCandidates[0].metadata.runtime, 24);

const contribution = contributionFromIssueEvent(issueEvent("add_provider_ref"));
assert.equal(contribution.ok, true);
assert.equal(contribution.contribution.operation.type, "add_provider_ref");

const createContribution = contributionFromIssueEvent(issueEvent("create_media"));
assert.equal(createContribution.ok, true);
assert.equal(createContribution.contribution.operation.type, "create_media");

const writeDir = mkdtempSync(join(tmpdir(), "animeatlas-contribution-"));
const outDir = join(writeDir, "approved");
const firstWrite = writeApprovedContributionRecord(contribution.contribution, { outDir });
const secondWrite = writeApprovedContributionRecord(contribution.contribution, { outDir });
assert.equal(firstWrite.written, true);
assert.equal(secondWrite.written, false);
assert.equal(JSON.parse(readFileSync(join(outDir, "issue-000042.json"), "utf8")).schema, "contribution/v1");

const applyRoot = mkdtempSync(join(tmpdir(), "animeatlas-apply-"));
copySeedRepo(applyRoot);
writeFileSync(join(applyRoot, "source/contributions/approved/issue-000042.json"), JSON.stringify(contribution.contribution, null, 2) + "\n");
const dryRun = applyRepositoryApprovedContributions({ root: applyRoot });
const applied = applyRepositoryApprovedContributions({ root: applyRoot, write: true });
const media = JSON.parse(readFileSync(join(applyRoot, "db/media/media-000001.json"), "utf8"));
const validation = validateRepository(applyRoot);
assert.equal(dryRun.written, false);
assert.equal(applied.appliedMutations, 1);
assert.deepEqual(applied.files, ["db/media/media-000001.json"]);
assert.equal(media.provider_refs.some((ref) => ref.provider === "myanimelist" && ref.entity === "anime" && ref.id === "999999"), true);
assert.equal(validation.ok, true, JSON.stringify(validation.issues));

const createRoot = mkdtempSync(join(tmpdir(), "animeatlas-create-"));
copySeedRepo(createRoot);
writeFileSync(join(createRoot, "source/contributions/approved/issue-000042.json"), JSON.stringify(createContribution.contribution, null, 2) + "\n");
const createApplied = applyRepositoryApprovedContributions({ root: createRoot, write: true });
const createdMedia = JSON.parse(readFileSync(join(createRoot, "db/media/media-000002.json"), "utf8"));
const createdAliases = JSON.parse(readFileSync(join(createRoot, "db/aliases/media-000002.json"), "utf8"));
const createdMetadata = JSON.parse(readFileSync(join(createRoot, "db/metadata/media-000002.json"), "utf8"));
const createValidation = validateRepository(createRoot);
assert.equal(createApplied.appliedMutations, 3);
assert.deepEqual(createApplied.files, ["db/aliases/media-000002.json", "db/media/media-000002.json", "db/metadata/media-000002.json"]);
assert.equal(createdMedia.provider_refs[0].id, "498947");
assert.equal(createdAliases.aliases[0].value, "Gachiakuta");
assert.equal(createdMetadata.metadata.title, "Gachiakuta");
assert.equal(createValidation.ok, true, JSON.stringify(createValidation.issues));
const createReapplyPlan = applyRepositoryApprovedContributions({ root: createRoot });
assert.equal(createReapplyPlan.plan.conflicts.length, 0);
assert.equal(createReapplyPlan.plan.mutations.length, 0);
assert.equal(createReapplyPlan.plan.noops.length, 1);

const v2Root = mkdtempSync(join(tmpdir(), "animeatlas-v2-contribution-"));
copyV2SeedRepo(v2Root);
const v2Contribution = contributionFromIssueEvent(v2IssueEvent(), { root: v2Root });
assert.equal(v2Contribution.ok, true, v2Contribution.ok ? undefined : v2Contribution.errors.join("; "));
assert.equal(v2Contribution.contribution.schema, "contribution/v2");
assert.equal(v2Contribution.contribution.target.media_id, "media-000007");
assert.equal(v2Contribution.contribution.target.installment.season, 4);
assert.equal(v2Contribution.contribution.changes[1].episode_id, "episode-000002");
writeApprovedContributionRecord(v2Contribution.contribution, { root: v2Root });
const v2Applied = applyRepositoryApprovedContributions({ root: v2Root, write: true });
const v2Episodes = JSON.parse(readFileSync(join(v2Root, "db/episodes/media-000007.json"), "utf8"));
const v2Episode = v2Episodes.episodes.find((episode) => episode.id === "episode-000002");
assert.equal(v2Applied.plan.conflicts.length, 0);
assert.equal(v2Applied.appliedMutations, 3);
assert.deepEqual(v2Episode.numbers.filter((number) => number.namespace === "release:observed").map((number) => number.value), [6, 78]);
assert.equal(validateRepository(v2Root).ok, true);
const wrongSeason = contributionFromIssueEvent(v2IssueEvent(3), { root: v2Root });
assert.equal(wrongSeason.ok, false);

console.log("Smoke checks passed.");
