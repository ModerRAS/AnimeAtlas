import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMediaId, normalizeAlias } from "@animeatlas/core";

type AnyRecord = Record<string, unknown>;

type JsonRecord = {
  file: string;
  data: unknown;
};

type ValidationIssue = {
  file: string;
  message: string;
};

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PROVIDER_KEY = /^[a-z][a-z0-9-]*$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ALIAS_TYPES = new Set(["official", "localized", "romaji", "nickname", "alternative", "legacy"]);
const PROVIDER_CAPABILITIES = new Set([
  "search",
  "resolve_ids",
  "fetch_metadata",
  "fetch_images",
  "fetch_relations",
  "bulk_import",
  "incremental_update"
]);
const PROHIBITED_METADATA_KEYS = new Set(["episode_run_time", "eps", "episodecount"]);
const REQUIRED_PROVENANCE_PATHS = ["metadata.title", "metadata.episode_count", "metadata.runtime"];

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  counts: {
    media: number;
    aliases: number;
    metadata: number;
    providers: number;
    contributions: number;
  };
};

export function validateRepository(root = findRepoRoot(process.cwd())): ValidationResult {
  const issues: ValidationIssue[] = [];
  const providerKeys = readProviderManifest(root, issues);
  const mediaRecords = readJsonRecords(join(root, "db", "media"), issues);
  const aliasRecords = readJsonRecords(join(root, "db", "aliases"), issues);
  const metadataRecords = readJsonRecords(join(root, "db", "metadata"), issues);
  const contributionRecords = readJsonRecords(join(root, "source", "contributions", "approved"), issues);

  if (mediaRecords.length === 0) {
    issues.push({ file: join(root, "db", "media"), message: "at least one media identity is required" });
  }

  const mediaIds = new Set<string>();
  const mediaKinds = new Map<string, string>();
  const providerRefsByMedia = new Map<string, Set<string>>();
  const externalRefs = new Map<string, string>();
  const graph = new Map<string, string[]>();

  for (const { file, data } of mediaRecords) {
    if (!isRecord(data)) {
      issues.push({ file, message: "media identity must be an object" });
      continue;
    }

    const id = data.id;
    if (!isMediaId(id)) {
      issues.push({ file, message: "media identity id must match media-000001 format" });
      continue;
    }

    if (basename(file) !== `${id}.json`) {
      issues.push({ file, message: "media identity filename must match id" });
    }

    if (data.schema !== "media-identity/v1") {
      issues.push({ file, message: "media identity schema must be media-identity/v1" });
    }

    if (data.kind !== "anime") {
      issues.push({ file, message: "media identity kind must be anime" });
    }

    if (mediaIds.has(id)) {
      issues.push({ file, message: `duplicate media id ${id}` });
    }
    mediaIds.add(id);
    mediaKinds.set(id, "anime");

    const refs = Array.isArray(data.provider_refs) ? data.provider_refs : [];
    if (!Array.isArray(data.provider_refs)) {
      issues.push({ file, message: "provider_refs must be an array" });
    }

    const localRefs = new Set<string>();
    for (const ref of refs) {
      if (!isProviderRef(ref)) {
        issues.push({ file, message: "provider_refs entries must include provider, entity, and id" });
        continue;
      }

      if (!providerKeys.has(ref.provider)) {
        issues.push({ file, message: `provider ref uses undeclared provider ${ref.provider}` });
      }

      const localKey = providerRefLocalKey(ref);
      localRefs.add(localKey);
      const globalKey = `anime:${localKey}`;
      const existing = externalRefs.get(globalKey);
      if (existing && existing !== id) {
        issues.push({ file, message: `provider ref ${globalKey} already maps to ${existing}` });
      }
      externalRefs.set(globalKey, id);
    }
    providerRefsByMedia.set(id, localRefs);

    const relationships = Array.isArray(data.relationships) ? data.relationships : [];
    if (!Array.isArray(data.relationships)) {
      issues.push({ file, message: "relationships must be an array" });
    }
    const targets: string[] = [];
    for (const relationship of relationships) {
      if (!isRecord(relationship) || typeof relationship.type !== "string" || !isMediaId(relationship.target)) {
        issues.push({ file, message: "relationship entries must include type and media target" });
        continue;
      }
      targets.push(relationship.target);
    }
    graph.set(id, targets);
  }

  for (const [source, targets] of graph.entries()) {
    for (const target of targets) {
      if (!mediaIds.has(target)) {
        issues.push({ file: `${source}.json`, message: `relationship target ${target} does not exist` });
      }
    }
  }
  for (const cycle of findCycles(graph)) {
    issues.push({ file: "db/media", message: `circular relationship detected: ${cycle.join(" -> ")}` });
  }

  const aliases = new Map<string, string>();
  for (const { file, data } of aliasRecords) {
    if (!isRecord(data)) {
      issues.push({ file, message: "alias record must be an object" });
      continue;
    }

    if (data.schema !== "media-aliases/v1") {
      issues.push({ file, message: "alias schema must be media-aliases/v1" });
    }

    const mediaId = data.media_id;
    if (!isMediaId(mediaId) || !mediaIds.has(mediaId)) {
      issues.push({ file, message: "alias media_id must reference an existing media identity" });
      continue;
    }

    if (basename(file) !== `${mediaId}.json`) {
      issues.push({ file, message: "alias filename must match media_id" });
    }

    if (!Array.isArray(data.aliases) || data.aliases.length === 0) {
      issues.push({ file, message: "aliases must be a non-empty array" });
      continue;
    }

    for (const alias of data.aliases) {
      if (!isRecord(alias)) {
        issues.push({ file, message: "alias entries must be objects" });
        continue;
      }

      if (typeof alias.value !== "string" || alias.value.trim() === "") {
        issues.push({ file, message: "alias value must be a non-empty string" });
        continue;
      }
      if (typeof alias.language !== "string" || !LANGUAGE_TAG.test(alias.language)) {
        issues.push({ file, message: `invalid language tag for alias ${alias.value}` });
      }
      if (typeof alias.type !== "string" || !ALIAS_TYPES.has(alias.type)) {
        issues.push({ file, message: `invalid alias type for alias ${alias.value}` });
      }
      if (typeof alias.source !== "string" || alias.source.trim() === "") {
        issues.push({ file, message: `alias ${alias.value} must include a source` });
      }
      if (typeof alias.confidence !== "number" || alias.confidence < 0 || alias.confidence > 1) {
        issues.push({ file, message: `alias ${alias.value} confidence must be between 0 and 1` });
      }

      const normalized = normalizeAlias(alias.value);
      const existing = aliases.get(normalized);
      if (existing) {
        issues.push({ file, message: `duplicate normalized alias ${JSON.stringify(normalized)} already maps to ${existing}` });
      } else {
        aliases.set(normalized, mediaId);
      }
    }
  }

  for (const { file, data } of metadataRecords) {
    if (!isRecord(data)) {
      issues.push({ file, message: "metadata record must be an object" });
      continue;
    }

    if (data.schema !== "media-metadata/v1") {
      issues.push({ file, message: "metadata schema must be media-metadata/v1" });
    }

    const mediaId = data.media_id;
    if (!isMediaId(mediaId) || !mediaIds.has(mediaId)) {
      issues.push({ file, message: "metadata media_id must reference an existing media identity" });
      continue;
    }

    if (basename(file) !== `${mediaId}.json`) {
      issues.push({ file, message: "metadata filename must match media_id" });
    }

    const metadata = data.metadata;
    if (!isRecord(metadata)) {
      issues.push({ file, message: "metadata must be an object" });
      continue;
    }

    for (const keyPath of findProhibitedMetadataKeys(metadata)) {
      issues.push({ file, message: `metadata leaks provider-native field ${keyPath}` });
    }

    if (typeof metadata.title !== "string" || metadata.title.trim() === "") {
      issues.push({ file, message: "metadata.title is required" });
    }
    if (!Number.isInteger(metadata.episode_count) || Number(metadata.episode_count) < 0) {
      issues.push({ file, message: "metadata.episode_count must be a non-negative integer" });
    }
    if (!Number.isInteger(metadata.runtime) || Number(metadata.runtime) < 0) {
      issues.push({ file, message: "metadata.runtime must be a non-negative integer" });
    }

    const meta = data._meta;
    if (!isRecord(meta) || !isRecord(meta.last_sync) || !isRecord(meta.fields)) {
      issues.push({ file, message: "metadata _meta must include last_sync and fields" });
      continue;
    }

    for (const [provider, syncedAt] of Object.entries(meta.last_sync)) {
      if (!PROVIDER_KEY.test(provider) || typeof syncedAt !== "string" || !isIsoDateTime(syncedAt)) {
        issues.push({ file, message: `invalid last_sync entry for provider ${provider}` });
      }
      if (!providerKeys.has(provider)) {
        issues.push({ file, message: `last_sync uses undeclared provider ${provider}` });
      }
    }

    for (const path of REQUIRED_PROVENANCE_PATHS) {
      if (readPath(data, path) === undefined) {
        issues.push({ file, message: `${path} is required` });
      }
      const provenance = meta.fields[path];
      if (!isRecord(provenance)) {
        issues.push({ file, message: `${path} is missing field provenance` });
        continue;
      }
      if (typeof provenance.source !== "string" || !PROVIDER_KEY.test(provenance.source)) {
        issues.push({ file, message: `${path} provenance source must be a provider key` });
      }
      if (typeof provenance.source === "string" && meta.last_sync[provenance.source] === undefined) {
        issues.push({ file, message: `${path} provenance source has no last_sync entry` });
      }
      if (typeof provenance.source === "string" && !providerKeys.has(provenance.source)) {
        issues.push({ file, message: `${path} provenance uses undeclared provider ${provenance.source}` });
      }
      if (typeof provenance.last_sync !== "string" || !isIsoDateTime(provenance.last_sync)) {
        issues.push({ file, message: `${path} provenance last_sync must be an ISO timestamp` });
      }
      if (typeof provenance.source_field !== "string" || provenance.source_field.trim() === "") {
        issues.push({ file, message: `${path} provenance source_field is required` });
      }
      if (typeof provenance.rule !== "string" || provenance.rule.trim() === "") {
        issues.push({ file, message: `${path} provenance rule is required` });
      }
      if (provenance.provider_ref !== undefined) {
        if (!isProviderRef(provenance.provider_ref)) {
          issues.push({ file, message: `${path} provenance provider_ref is invalid` });
        } else {
          const refs = providerRefsByMedia.get(mediaId) ?? new Set<string>();
          if (!refs.has(providerRefLocalKey(provenance.provider_ref))) {
            issues.push({ file, message: `${path} provenance provider_ref is not linked to ${mediaId}` });
          }
        }
      }
    }
  }

  validateContributionRecords(contributionRecords, mediaIds, providerKeys, issues);

  return {
    ok: issues.length === 0,
    issues,
    counts: {
      media: mediaRecords.length,
      aliases: aliasRecords.length,
      metadata: metadataRecords.length,
      providers: providerKeys.size,
      contributions: contributionRecords.length
    }
  };
}

function validateContributionRecords(
  records: JsonRecord[],
  mediaIds: Set<string>,
  providerKeys: Set<string>,
  issues: ValidationIssue[]
): void {
  const issueNumbers = new Set<number>();
  for (const { file, data } of records) {
    if (!isRecord(data)) {
      issues.push({ file, message: "contribution record must be an object" });
      continue;
    }
    if (data.schema !== "contribution/v1") {
      issues.push({ file, message: "contribution schema must be contribution/v1" });
    }

    const issue = data.issue;
    if (!isRecord(issue) || !Number.isInteger(issue.number) || Number(issue.number) < 1) {
      issues.push({ file, message: "contribution issue.number is required" });
      continue;
    }
    const issueNumber = Number(issue.number);
    const expectedName = `issue-${String(issueNumber).padStart(6, "0")}.json`;
    if (basename(file) !== expectedName) {
      issues.push({ file, message: `contribution filename must be ${expectedName}` });
    }
    if (issueNumbers.has(issueNumber)) {
      issues.push({ file, message: `duplicate approved contribution for issue ${issueNumber}` });
    }
    issueNumbers.add(issueNumber);
    if (typeof issue.url !== "string" || !/^https?:\/\//.test(issue.url)) {
      issues.push({ file, message: "contribution issue.url must be an http(s) URL" });
    }
    if (typeof issue.author !== "string" || issue.author.trim() === "") {
      issues.push({ file, message: "contribution issue.author is required" });
    }

    const review = data.review;
    if (!isRecord(review) || typeof review.approved_by !== "string" || review.approved_by.trim() === "") {
      issues.push({ file, message: "contribution review.approved_by is required" });
    }
    if (!isRecord(review) || typeof review.approved_at !== "string" || !isIsoDateTime(review.approved_at)) {
      issues.push({ file, message: "contribution review.approved_at must be an ISO timestamp" });
    }

    const operation = data.operation;
    if (!isRecord(operation) || typeof operation.type !== "string") {
      issues.push({ file, message: "contribution operation.type is required" });
      continue;
    }
    if (typeof operation.media_id !== "string" || !isMediaId(operation.media_id) || !mediaIds.has(operation.media_id)) {
      issues.push({ file, message: "contribution operation.media_id must reference an existing media identity" });
    }
    if (typeof operation.evidence_url !== "string" || !/^https?:\/\//.test(operation.evidence_url)) {
      issues.push({ file, message: "contribution operation.evidence_url must be an http(s) URL" });
    }

    if (operation.type === "add_alias") {
      validateContributionAliasOperation(file, operation, issues);
    } else if (operation.type === "add_provider_ref") {
      validateContributionProviderRefOperation(file, operation, providerKeys, issues);
    } else if (operation.type === "correct_metadata") {
      validateContributionMetadataOperation(file, operation, providerKeys, issues);
    } else {
      issues.push({ file, message: `unsupported approved contribution operation ${operation.type}` });
    }
  }
}

function validateContributionAliasOperation(file: string, operation: AnyRecord, issues: ValidationIssue[]): void {
  const alias = operation.alias;
  if (!isRecord(alias)) {
    issues.push({ file, message: "add_alias contribution must include alias object" });
    return;
  }
  if (typeof alias.value !== "string" || alias.value.trim() === "") {
    issues.push({ file, message: "add_alias alias.value is required" });
  }
  if (typeof alias.language !== "string" || !LANGUAGE_TAG.test(alias.language)) {
    issues.push({ file, message: "add_alias alias.language must be valid" });
  }
  if (typeof alias.type !== "string" || !ALIAS_TYPES.has(alias.type)) {
    issues.push({ file, message: "add_alias alias.type must be valid" });
  }
  if (alias.source !== "community") {
    issues.push({ file, message: "add_alias alias.source must be community" });
  }
  if (typeof alias.confidence !== "number" || alias.confidence < 0 || alias.confidence > 1) {
    issues.push({ file, message: "add_alias alias.confidence must be between 0 and 1" });
  }
}

function validateContributionProviderRefOperation(
  file: string,
  operation: AnyRecord,
  providerKeys: Set<string>,
  issues: ValidationIssue[]
): void {
  const ref = operation.provider_ref;
  if (!isProviderRef(ref)) {
    issues.push({ file, message: "add_provider_ref contribution must include provider_ref" });
    return;
  }
  if (!providerKeys.has(ref.provider)) {
    issues.push({ file, message: `add_provider_ref uses undeclared provider ${ref.provider}` });
  }
}

function validateContributionMetadataOperation(
  file: string,
  operation: AnyRecord,
  providerKeys: Set<string>,
  issues: ValidationIssue[]
): void {
  if (typeof operation.field !== "string" || !operation.field.startsWith("metadata.")) {
    issues.push({ file, message: "correct_metadata field must use metadata.* path" });
  }
  const provenance = operation.provenance;
  if (!isRecord(provenance)) {
    issues.push({ file, message: "correct_metadata provenance is required" });
    return;
  }
  if (typeof provenance.source !== "string" || !providerKeys.has(provenance.source)) {
    issues.push({ file, message: "correct_metadata provenance.source must be a declared provider" });
  }
  if (typeof provenance.source_field !== "string" || provenance.source_field.trim() === "") {
    issues.push({ file, message: "correct_metadata provenance.source_field is required" });
  }
}

function readProviderManifest(root: string, issues: ValidationIssue[]): Set<string> {
  const file = join(root, "source", "manifests", "providers.json");
  const providerKeys = new Set<string>();
  if (!existsSync(file)) {
    issues.push({ file, message: "provider manifest list is required" });
    return providerKeys;
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    issues.push({ file, message: error instanceof Error ? error.message : "invalid provider manifest JSON" });
    return providerKeys;
  }

  if (!isRecord(data) || data.schema !== "provider-manifest-list/v1" || !Array.isArray(data.providers)) {
    issues.push({ file, message: "provider manifest list must use provider-manifest-list/v1 and include providers[]" });
    return providerKeys;
  }

  for (const manifest of data.providers) {
    if (!isRecord(manifest)) {
      issues.push({ file, message: "provider manifest entries must be objects" });
      continue;
    }

    if (manifest.schema !== "provider-manifest/v1") {
      issues.push({ file, message: "provider manifest schema must be provider-manifest/v1" });
    }
    if (typeof manifest.provider !== "string" || !PROVIDER_KEY.test(manifest.provider)) {
      issues.push({ file, message: "provider manifest provider must be a stable provider key" });
      continue;
    }
    if (providerKeys.has(manifest.provider)) {
      issues.push({ file, message: `duplicate provider manifest for ${manifest.provider}` });
    }
    providerKeys.add(manifest.provider);

    if (typeof manifest.display_name !== "string" || manifest.display_name.trim() === "") {
      issues.push({ file, message: `${manifest.provider} display_name is required` });
    }
    if (!Array.isArray(manifest.entity_types) || !manifest.entity_types.includes("anime")) {
      issues.push({ file, message: `${manifest.provider} must declare anime entity support` });
    }
    if (!Array.isArray(manifest.capabilities)) {
      issues.push({ file, message: `${manifest.provider} capabilities must be an array` });
      continue;
    }
    for (const capability of manifest.capabilities) {
      if (typeof capability !== "string" || !PROVIDER_CAPABILITIES.has(capability)) {
        issues.push({ file, message: `${manifest.provider} declares invalid capability ${String(capability)}` });
      }
    }
  }

  return providerKeys;
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

function readJsonRecords(dir: string, issues: ValidationIssue[]): JsonRecord[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      try {
        return { file, data: JSON.parse(readFileSync(file, "utf8")) };
      } catch (error) {
        issues.push({ file, message: error instanceof Error ? error.message : "invalid JSON" });
        return { file, data: null };
      }
    });
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProviderRef(value: unknown): value is { provider: string; entity: string; id: string } {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    PROVIDER_KEY.test(value.provider) &&
    typeof value.entity === "string" &&
    PROVIDER_KEY.test(value.entity) &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function providerRefLocalKey(ref: { provider: string; entity: string; id: string }): string {
  return `${ref.provider}:${ref.entity}:${ref.id}`;
}

function isIsoDateTime(value: string): boolean {
  return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
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

function findProhibitedMetadataKeys(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findProhibitedMetadataKeys(item, [...path, String(index)]));
  }
  if (!isRecord(value)) {
    return [];
  }

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (PROHIBITED_METADATA_KEYS.has(key)) {
      found.push(childPath.join("."));
    }
    found.push(...findProhibitedMetadataKeys(child, childPath));
  }
  return found;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string, stack: string[]): void {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      visit(next, [...stack, next]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    visit(node, [node]);
  }
  return cycles;
}
