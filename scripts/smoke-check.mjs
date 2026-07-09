import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  for (const dir of ["source/manifests", "source/contributions/approved", "db/media", "db/aliases", "db/metadata"]) {
    mkdirSync(join(target, dir), { recursive: true });
  }
  copyFileSync("source/manifests/providers.json", join(target, "source/manifests/providers.json"));
  copyFileSync("db/media/media-000001.json", join(target, "db/media/media-000001.json"));
  copyFileSync("db/aliases/media-000001.json", join(target, "db/aliases/media-000001.json"));
  copyFileSync("db/metadata/media-000001.json", join(target, "db/metadata/media-000001.json"));
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

const aliasResult = runCliJson(["resolve", "alias", "Sousou no Frieren", "--compact"]);
assert.equal(aliasResult.found, true);
assert.equal(aliasResult.media_id, "media-000001");
assert.equal(aliasResult.metadata.title, "葬送的芙莉莲");
assert.equal(aliasResult.provenance.fields["metadata.title"].source, "bangumi");

const providerResult = runCliJson(["resolve", "provider", "bangumi", "subject", "443666", "--compact"]);
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
    { id: 443666, type: 2, name: "Sousou no Frieren", name_cn: "葬送的芙莉莲", eps: 28, duration: "24m" },
    { id: 1, type: 1, name: "Not Anime" },
    { id: 999999, type: 2, name: "Example Anime", eps: 12, duration: "00:24:00" }
  ].map((row) => JSON.stringify(row)).join("\n") + "\n"
);
const archiveProvider = createBangumiArchiveProviderFromFile(archiveFile, { lastSync: "2026-07-08T12:34:56Z" });
const archivePlan = await planRepositoryMediaImport({ candidates: archiveProvider.bulkImport() });
assert.deepEqual(archivePlan.matches.map((item) => item.mediaId), ["media-000001"]);
assert.deepEqual(archivePlan.creates.map((item) => item.mediaId), ["media-000002"]);
assert.equal(archivePlan.conflicts.length, 0);

const seenApiUrls = [];
const apiProvider = createBangumiApiProvider({
  subjectIds: [443666],
  baseUrl: "https://api.example.test",
  lastSync: "2026-07-08T12:34:56Z",
  fetchImpl: async (url, init) => {
    seenApiUrls.push({ url, headers: init?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { id: 443666, type: 2, name: "Sousou no Frieren", name_cn: "葬送的芙莉莲", eps: 28, duration: "24m" };
      }
    };
  }
});
const apiCandidates = [];
for await (const candidate of apiProvider.incrementalUpdate()) {
  apiCandidates.push(candidate);
}
assert.equal(seenApiUrls[0].url, "https://api.example.test/v0/subjects/443666");
assert.equal(bangumiApiSubjectUrl(443666, "https://api.example.test/"), "https://api.example.test/v0/subjects/443666");
assert.equal(apiCandidates.length, 1);
assert.equal(apiCandidates[0].providerRef.id, "443666");
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

console.log("Smoke checks passed.");
