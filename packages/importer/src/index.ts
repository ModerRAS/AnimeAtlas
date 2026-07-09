import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatMediaId, isMediaId, mediaIdNumber, normalizeAlias, stableStringify } from "@animeatlas/core";
import { NormalizedMediaCandidate, ProviderRef, providerRefKey } from "@animeatlas/providers";

export type ExistingMediaIdentity = {
  id: string;
  kind: "anime";
  provider_refs: readonly ProviderRef[];
};

export type ImportPlanMatch = {
  type: "match";
  mediaId: string;
  candidate: NormalizedMediaCandidate;
  matchedBy: "provider_ref";
};

export type ImportPlanCreate = {
  type: "create";
  mediaId: string;
  candidate: NormalizedMediaCandidate;
};

export type ImportConflict = {
  type: "existing_provider_ref_conflict" | "duplicate_candidate_ref" | "invalid_existing_media_id";
  message: string;
  providerRef?: ProviderRef;
  mediaIds?: readonly string[];
};

export type ImportPlan = {
  matches: ImportPlanMatch[];
  creates: ImportPlanCreate[];
  conflicts: ImportConflict[];
};

export type ApprovedContributionRecord = {
  schema: "contribution/v1";
  issue: {
    number: number;
    url: string;
    author: string;
  };
  operation: Record<string, unknown> & {
    type: "create_media" | "add_alias" | "add_provider_ref" | "correct_metadata";
    media_id?: unknown;
  };
  review: {
    approved_by: string;
    approved_at: string;
  };
};

export type ContributionMutation = {
  issue: number;
  type: "append_alias" | "append_provider_ref" | "set_metadata_field" | "create_media" | "create_alias_record" | "create_metadata_record";
  mediaId: string;
  targetFile: string;
  path: string;
  value: unknown;
};

export type ContributionNoop = {
  issue: number;
  type: "noop";
  mediaId?: string;
  message: string;
};

export type ContributionConflict = {
  issue: number;
  type:
    | "invalid_contribution"
    | "missing_media"
    | "duplicate_alias"
    | "provider_ref_conflict"
    | "missing_record";
  mediaId?: string;
  targetFile?: string;
  message: string;
};

export type ApprovedContributionPlan = {
  mutations: ContributionMutation[];
  noops: ContributionNoop[];
  conflicts: ContributionConflict[];
};

export type ApplyApprovedContributionResult = {
  plan: ApprovedContributionPlan;
  written: boolean;
  appliedMutations: number;
  files: string[];
};

export async function planRepositoryMediaImport(input: {
  root?: string;
  candidates: Iterable<NormalizedMediaCandidate> | AsyncIterable<NormalizedMediaCandidate>;
}): Promise<ImportPlan> {
  return planMediaImport({
    existingMedia: readExistingMediaIdentities(input.root),
    candidates: await collectCandidates(input.candidates)
  });
}

export async function collectCandidates(
  candidates: Iterable<NormalizedMediaCandidate> | AsyncIterable<NormalizedMediaCandidate>
): Promise<NormalizedMediaCandidate[]> {
  const collected: NormalizedMediaCandidate[] = [];
  for await (const candidate of iterate(candidates)) {
    collected.push(candidate);
  }
  return collected;
}

export function readExistingMediaIdentities(root = findRepoRoot(process.cwd())): ExistingMediaIdentity[] {
  const dir = join(root, "db", "media");
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readExistingMediaIdentity(join(dir, name)));
}

export function readApprovedContributions(root = findRepoRoot(process.cwd())): ApprovedContributionRecord[] {
  const dir = join(root, "source", "contributions", "approved");
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ApprovedContributionRecord);
}

export function planRepositoryApprovedContributions(root = findRepoRoot(process.cwd())): ApprovedContributionPlan {
  return planApprovedContributions({
    root,
    existingMedia: readExistingMediaIdentities(root),
    contributions: readApprovedContributions(root)
  });
}

export function applyRepositoryApprovedContributions(input: {
  root?: string;
  write?: boolean;
} = {}): ApplyApprovedContributionResult {
  const root = input.root ?? findRepoRoot(process.cwd());
  const plan = planRepositoryApprovedContributions(root);
  if (plan.conflicts.length > 0) {
    return { plan, written: false, appliedMutations: 0, files: [] };
  }
  if (!input.write) {
    return { plan, written: false, appliedMutations: 0, files: [] };
  }

  const files = applyApprovedContributionPlan(root, plan);
  return {
    plan,
    written: files.length > 0,
    appliedMutations: plan.mutations.length,
    files
  };
}

export function applyApprovedContributionPlan(root: string, plan: ApprovedContributionPlan): string[] {
  if (plan.conflicts.length > 0) {
    throw new Error("Cannot apply approved contribution plan with conflicts.");
  }

  const touched = new Set<string>();
  for (const mutation of plan.mutations) {
    const file = join(root, mutation.targetFile);

    if (mutation.type === "create_media" || mutation.type === "create_alias_record" || mutation.type === "create_metadata_record") {
      if (existsSync(file)) {
        throw new Error(`Cannot create ${mutation.targetFile}; file already exists.`);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, stableStringify(mutation.value));
      touched.add(mutation.targetFile);
      continue;
    }

    const data = readMutableJsonObject(file);

    if (mutation.type === "append_alias") {
      appendArrayValue(data, "aliases", mutation.value);
    } else if (mutation.type === "append_provider_ref") {
      appendArrayValue(data, "provider_refs", mutation.value);
    } else if (mutation.type === "set_metadata_field") {
      setPath(data, mutation.path, mutation.value);
    }

    writeFileSync(file, stableStringify(data));
    touched.add(mutation.targetFile);
  }

  return [...touched].sort();
}

export function planApprovedContributions(input: {
  root?: string;
  existingMedia: readonly ExistingMediaIdentity[];
  contributions: readonly ApprovedContributionRecord[];
}): ApprovedContributionPlan {
  const root = input.root ?? findRepoRoot(process.cwd());
  const mediaById = new Map(input.existingMedia.map((media) => [media.id, media]));
  const mediaIds = new Set(input.existingMedia.map((media) => media.id).filter(isMediaId));
  const providerRefs = providerRefIndex(input.existingMedia);
  const aliasIndex = readAliasIndex(root);
  const plan: ApprovedContributionPlan = { mutations: [], noops: [], conflicts: [] };

  for (const contribution of input.contributions) {
    const issue = contribution.issue?.number ?? 0;
    const operation = contribution.operation;
    const mediaId = typeof operation?.media_id === "string" ? operation.media_id : undefined;

    if (operation.type === "create_media") {
      planCreateMedia(root, plan, contribution, mediaIds, mediaById, providerRefs, aliasIndex);
      continue;
    }

    if (!mediaId || !isMediaId(mediaId)) {
      plan.conflicts.push({ issue, type: "invalid_contribution", message: "Contribution operation.media_id is invalid." });
      continue;
    }
    if (!mediaById.has(mediaId)) {
      plan.conflicts.push({ issue, type: "missing_media", mediaId, message: `Media ${mediaId} does not exist.` });
      continue;
    }

    if (operation.type === "add_alias") {
      planAddAlias(root, plan, contribution, mediaId, aliasIndex);
    } else if (operation.type === "add_provider_ref") {
      planAddProviderRef(root, plan, contribution, mediaId, providerRefs);
    } else if (operation.type === "correct_metadata") {
      planCorrectMetadata(root, plan, contribution, mediaId);
    } else {
      plan.conflicts.push({ issue, type: "invalid_contribution", mediaId, message: `Unsupported operation ${String(operation.type)}.` });
    }
  }

  return plan;
}

export function planMediaImport(input: {
  existingMedia: readonly ExistingMediaIdentity[];
  candidates: readonly NormalizedMediaCandidate[];
}): ImportPlan {
  const conflicts: ImportConflict[] = [];
  const matches: ImportPlanMatch[] = [];
  const creates: ImportPlanCreate[] = [];
  const mediaIds = new Set<string>();
  const providerRefs = new Map<string, { ref: ProviderRef; mediaId: string }>();

  for (const media of input.existingMedia) {
    if (!isMediaId(media.id)) {
      conflicts.push({
        type: "invalid_existing_media_id",
        message: `Existing media id ${media.id} is not a valid media-* id`,
        mediaIds: [media.id]
      });
      continue;
    }

    mediaIds.add(media.id);
    for (const ref of media.provider_refs) {
      const key = providerRefKey(ref);
      const existing = providerRefs.get(key);
      if (existing && existing.mediaId !== media.id) {
        conflicts.push({
          type: "existing_provider_ref_conflict",
          message: `Provider ref ${key} maps to both ${existing.mediaId} and ${media.id}`,
          providerRef: ref,
          mediaIds: [existing.mediaId, media.id]
        });
        continue;
      }
      providerRefs.set(key, { ref, mediaId: media.id });
    }
  }

  const seenCandidateRefs = new Set<string>();
  let next = nextMediaSequence(mediaIds);

  for (const candidate of input.candidates) {
    const key = providerRefKey(candidate.providerRef);
    if (seenCandidateRefs.has(key)) {
      conflicts.push({
        type: "duplicate_candidate_ref",
        message: `Import batch contains duplicate provider ref ${key}`,
        providerRef: candidate.providerRef
      });
      continue;
    }
    seenCandidateRefs.add(key);

    const existing = providerRefs.get(key);
    if (existing) {
      matches.push({
        type: "match",
        mediaId: existing.mediaId,
        candidate,
        matchedBy: "provider_ref"
      });
      continue;
    }

    const mediaId = formatMediaId(next);
    next += 1;
    mediaIds.add(mediaId);
    providerRefs.set(key, { ref: candidate.providerRef, mediaId });
    creates.push({ type: "create", mediaId, candidate });
  }

  return { matches, creates, conflicts };
}

function planCreateMedia(
  root: string,
  plan: ApprovedContributionPlan,
  contribution: ApprovedContributionRecord,
  mediaIds: Set<string>,
  mediaById: Map<string, ExistingMediaIdentity>,
  providerRefs: Map<string, string>,
  aliasIndex: Map<string, string>
): void {
  const issue = contribution.issue.number;
  const operation = contribution.operation;
  const title = typeof operation.title === "string" ? operation.title.trim() : "";
  const ref = operation.provider_ref;
  const alias = operation.alias;

  if (!title) {
    plan.conflicts.push({ issue, type: "invalid_contribution", message: "create_media requires title." });
    return;
  }
  if (!isProviderRef(ref)) {
    plan.conflicts.push({ issue, type: "invalid_contribution", message: "create_media requires provider_ref." });
    return;
  }
  if (!isRecord(alias) || typeof alias.value !== "string") {
    plan.conflicts.push({ issue, type: "invalid_contribution", message: "create_media requires alias.value." });
    return;
  }

  const providerKey = providerRefKey(ref);
  const normalizedAlias = normalizeAlias(alias.value);
  const existingProviderMedia = providerRefs.get(providerKey);
  const existingAliasMedia = aliasIndex.get(normalizedAlias);
  if (existingProviderMedia) {
    if (existingAliasMedia === existingProviderMedia) {
      plan.noops.push({ issue, type: "noop", mediaId: existingProviderMedia, message: `create_media already applied for ${existingProviderMedia}.` });
    } else {
      plan.conflicts.push({ issue, type: "provider_ref_conflict", mediaId: existingProviderMedia, message: `Provider ref ${providerKey} already maps to ${existingProviderMedia}.` });
    }
    return;
  }

  if (existingAliasMedia) {
    plan.conflicts.push({ issue, type: "duplicate_alias", mediaId: existingAliasMedia, message: `Alias ${JSON.stringify(alias.value)} already resolves to ${existingAliasMedia}.` });
    return;
  }

  const mediaId = formatMediaId(nextMediaSequence(mediaIds));
  mediaIds.add(mediaId);
  mediaById.set(mediaId, { id: mediaId, kind: "anime", provider_refs: [ref] });
  providerRefs.set(providerKey, mediaId);
  aliasIndex.set(normalizedAlias, mediaId);

  const approvedAt = contribution.review.approved_at;
  const providerRef = { provider: ref.provider, entity: ref.entity, id: ref.id };
  const metadataFieldMeta = {
    source: ref.provider,
    source_field: "issue",
    last_sync: approvedAt,
    rule: "approved issue contribution",
    provider_ref: providerRef
  };

  plan.mutations.push(
    {
      issue,
      type: "create_media",
      mediaId,
      targetFile: repoPath(root, mediaFile(root, mediaId)),
      path: "db/media",
      value: {
        $schema: "../../packages/schema/schemas/media-identity.schema.json",
        schema: "media-identity/v1",
        id: mediaId,
        kind: "anime",
        provider_refs: [providerRef],
        relationships: []
      }
    },
    {
      issue,
      type: "create_alias_record",
      mediaId,
      targetFile: repoPath(root, aliasFile(root, mediaId)),
      path: "db/aliases",
      value: {
        $schema: "../../packages/schema/schemas/media-aliases.schema.json",
        schema: "media-aliases/v1",
        media_id: mediaId,
        aliases: [alias]
      }
    },
    {
      issue,
      type: "create_metadata_record",
      mediaId,
      targetFile: repoPath(root, metadataFile(root, mediaId)),
      path: "db/metadata",
      value: {
        $schema: "../../packages/schema/schemas/media-metadata.schema.json",
        schema: "media-metadata/v1",
        media_id: mediaId,
        metadata: {
          title,
          episode_count: 0,
          runtime: 0
        },
        _meta: {
          last_sync: {
            [ref.provider]: approvedAt
          },
          fields: {
            "metadata.title": metadataFieldMeta,
            "metadata.episode_count": metadataFieldMeta,
            "metadata.runtime": metadataFieldMeta
          }
        }
      }
    }
  );
}

function planAddAlias(
  root: string,
  plan: ApprovedContributionPlan,
  contribution: ApprovedContributionRecord,
  mediaId: string,
  aliasIndex: Map<string, string>
): void {
  const issue = contribution.issue.number;
  const alias = contribution.operation.alias;
  if (!isRecord(alias) || typeof alias.value !== "string") {
    plan.conflicts.push({ issue, type: "invalid_contribution", mediaId, message: "add_alias requires alias.value." });
    return;
  }

  const normalized = normalizeAlias(alias.value);
  const existing = aliasIndex.get(normalized);
  if (existing && existing !== mediaId) {
    plan.conflicts.push({
      issue,
      type: "duplicate_alias",
      mediaId,
      message: `Alias ${JSON.stringify(alias.value)} already resolves to ${existing}.`
    });
    return;
  }
  if (existing === mediaId) {
    plan.noops.push({ issue, type: "noop", mediaId, message: `Alias ${JSON.stringify(alias.value)} already exists for ${mediaId}.` });
    return;
  }

  aliasIndex.set(normalized, mediaId);
  plan.mutations.push({
    issue,
    type: "append_alias",
    mediaId,
    targetFile: repoPath(root, aliasFile(root, mediaId)),
    path: "aliases[]",
    value: alias
  });
}

function planAddProviderRef(
  root: string,
  plan: ApprovedContributionPlan,
  contribution: ApprovedContributionRecord,
  mediaId: string,
  providerRefs: Map<string, string>
): void {
  const issue = contribution.issue.number;
  const ref = contribution.operation.provider_ref;
  if (!isProviderRef(ref)) {
    plan.conflicts.push({ issue, type: "invalid_contribution", mediaId, message: "add_provider_ref requires provider_ref." });
    return;
  }

  const key = providerRefKey(ref);
  const existing = providerRefs.get(key);
  if (existing && existing !== mediaId) {
    plan.conflicts.push({ issue, type: "provider_ref_conflict", mediaId, message: `Provider ref ${key} already maps to ${existing}.` });
    return;
  }
  if (existing === mediaId) {
    plan.noops.push({ issue, type: "noop", mediaId, message: `Provider ref ${key} already exists for ${mediaId}.` });
    return;
  }

  providerRefs.set(key, mediaId);
  plan.mutations.push({
    issue,
    type: "append_provider_ref",
    mediaId,
    targetFile: repoPath(root, mediaFile(root, mediaId)),
    path: "provider_refs[]",
    value: ref
  });
}

function planCorrectMetadata(
  root: string,
  plan: ApprovedContributionPlan,
  contribution: ApprovedContributionRecord,
  mediaId: string
): void {
  const issue = contribution.issue.number;
  const field = contribution.operation.field;
  if (typeof field !== "string" || !field.startsWith("metadata.")) {
    plan.conflicts.push({ issue, type: "invalid_contribution", mediaId, message: "correct_metadata requires metadata.* field." });
    return;
  }

  const file = metadataFile(root, mediaId);
  if (!existsSync(file)) {
    plan.conflicts.push({
      issue,
      type: "missing_record",
      mediaId,
      targetFile: repoPath(root, file),
      message: `Metadata record for ${mediaId} does not exist.`
    });
    return;
  }

  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const current = readPath(data, field);
  const next = contribution.operation.value;
  if (JSON.stringify(current) === JSON.stringify(next)) {
    plan.noops.push({ issue, type: "noop", mediaId, message: `${field} already has the requested value.` });
    return;
  }

  plan.mutations.push({
    issue,
    type: "set_metadata_field",
    mediaId,
    targetFile: repoPath(root, file),
    path: field,
    value: next
  });
}

function readMutableJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) {
    throw new Error(`Cannot apply mutation because ${file} does not exist.`);
  }
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(data)) {
    throw new Error(`Cannot apply mutation because ${file} is not a JSON object.`);
  }
  return data;
}

function appendArrayValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const current = target[key];
  if (!Array.isArray(current)) {
    throw new Error(`Cannot append to ${key}; target is not an array.`);
  }
  current.push(value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      throw new Error(`Cannot set ${path}; ${part} is not an object.`);
    }
    current = next;
  }
  current[parts[parts.length - 1]] = value;
}

function readExistingMediaIdentity(file: string): ExistingMediaIdentity {
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(data)) {
    return { id: basename(file, ".json"), kind: "anime", provider_refs: [] };
  }

  return {
    id: typeof data.id === "string" ? data.id : basename(file, ".json"),
    kind: "anime",
    provider_refs: Array.isArray(data.provider_refs) ? data.provider_refs.filter(isProviderRef) : []
  };
}

function providerRefIndex(media: readonly ExistingMediaIdentity[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const item of media) {
    for (const ref of item.provider_refs) {
      refs.set(providerRefKey(ref), item.id);
    }
  }
  return refs;
}

function readAliasIndex(root: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const dir = join(root, "db", "aliases");
  if (!existsSync(dir)) {
    return aliases;
  }

  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    const file = join(dir, name);
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(data) || typeof data.media_id !== "string" || !Array.isArray(data.aliases)) {
      continue;
    }
    for (const alias of data.aliases) {
      if (isRecord(alias) && typeof alias.value === "string") {
        aliases.set(normalizeAlias(alias.value), data.media_id);
      }
    }
  }
  return aliases;
}

function mediaFile(root: string, mediaId: string): string {
  return join(root, "db", "media", `${mediaId}.json`);
}

function aliasFile(root: string, mediaId: string): string {
  return join(root, "db", "aliases", `${mediaId}.json`);
}

function metadataFile(root: string, mediaId: string): string {
  return join(root, "db", "metadata", `${mediaId}.json`);
}

function repoPath(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length + 1).replace(/\\/g, "/") : file;
}

function isProviderRef(value: unknown): value is ProviderRef {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.entity === "string" &&
    typeof value.id === "string"
  );
}

function findRepoRoot(start: string): string {
  let current = start;
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
  return current;
}

async function* iterate<T>(values: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in Object(values)) {
    yield* values as AsyncIterable<T>;
    return;
  }
  yield* values as Iterable<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function nextMediaSequence(mediaIds: Set<string>): number {
  let max = 0;
  for (const id of mediaIds) {
    max = Math.max(max, mediaIdNumber(id));
  }
  return max + 1;
}
