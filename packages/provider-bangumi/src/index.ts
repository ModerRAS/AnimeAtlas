import { createReadStream, readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import {
  AnimeAtlasProvider,
  NormalizedAliasCandidate,
  NormalizedMediaCandidate,
  ProviderManifest,
  ProviderRef
} from "@animeatlas/providers";

export const BANGUMI_PROVIDER_KEY = "bangumi";
export const BANGUMI_SUBJECT_ENTITY = "subject";
export const BANGUMI_ANIME_SUBJECT_TYPE = 2;
export const DEFAULT_LAST_SYNC = "1970-01-01T00:00:00Z";

export type BangumiArchiveInfoboxItem = {
  key?: unknown;
  value?: unknown;
};

export type BangumiArchiveSubject = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  name_cn?: unknown;
  summary?: unknown;
  eps?: unknown;
  total_episodes?: unknown;
  date?: unknown;
  duration?: unknown;
  images?: unknown;
  rating?: unknown;
  tags?: unknown;
  infobox?: unknown;
};

export type BangumiArchiveNormalizeOptions = {
  lastSync?: string;
  rawRef?: string;
};

export type BangumiArchiveProviderOptions = {
  lastSync?: string;
  rawRef?: string | ((subject: BangumiArchiveSubject) => string | undefined);
};

export type BangumiArchiveFileOptions = BangumiArchiveProviderOptions & {
  format?: "auto" | "json" | "jsonl";
};

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

export type BangumiApiProviderOptions = {
  subjectIds: Iterable<string | number> | AsyncIterable<string | number>;
  baseUrl?: string;
  token?: string;
  userAgent?: string;
  fetchImpl?: FetchLike;
  lastSync?: string;
  rawRef?: string | ((subject: BangumiArchiveSubject) => string | undefined);
};

export const bangumiProviderManifest: ProviderManifest = {
  provider: BANGUMI_PROVIDER_KEY,
  displayName: "Bangumi",
  entityTypes: ["anime"],
  capabilities: [
    "search",
    "resolve_ids",
    "fetch_metadata",
    "fetch_images",
    "fetch_relations",
    "bulk_import",
    "incremental_update"
  ]
};

export function createBangumiArchiveProvider(
  subjects: Iterable<BangumiArchiveSubject> | AsyncIterable<BangumiArchiveSubject>,
  options: BangumiArchiveProviderOptions = {}
): AnimeAtlasProvider {
  return {
    manifest: bangumiProviderManifest,
    async *bulkImport() {
      for await (const subject of iterate(subjects)) {
        const candidate = normalizeBangumiArchiveSubject(subject, {
          lastSync: options.lastSync,
          rawRef: typeof options.rawRef === "function" ? options.rawRef(subject) : options.rawRef
        });
        if (candidate) {
          yield candidate;
        }
      }
    }
  };
}

export function createBangumiArchiveProviderFromFile(
  filePath: string,
  options: BangumiArchiveFileOptions = {}
): AnimeAtlasProvider {
  return createBangumiArchiveProvider(readBangumiArchiveSubjects(filePath, options), {
    lastSync: options.lastSync,
    rawRef: options.rawRef ?? ((subject) => `${filePath}#subject:${stringFrom(subject.id) ?? "unknown"}`)
  });
}

export function createBangumiApiProvider(options: BangumiApiProviderOptions): AnimeAtlasProvider {
  return {
    manifest: bangumiProviderManifest,
    async *incrementalUpdate() {
      for await (const subjectId of iterate(options.subjectIds)) {
        const subject = await fetchBangumiApiSubject(subjectId, options);
        const candidate = normalizeBangumiArchiveSubject(subject, {
          lastSync: options.lastSync,
          rawRef: typeof options.rawRef === "function" ? options.rawRef(subject) : options.rawRef ?? bangumiApiSubjectUrl(subjectId, options.baseUrl)
        });
        if (candidate) {
          yield candidate;
        }
      }
    }
  };
}

export async function fetchBangumiApiSubject(
  subjectId: string | number,
  options: Omit<BangumiApiProviderOptions, "subjectIds"> = {}
): Promise<BangumiArchiveSubject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(bangumiApiSubjectUrl(subjectId, options.baseUrl), {
    headers: bangumiApiHeaders(options)
  });
  if (!response.ok) {
    throw new Error(`Bangumi API subject ${subjectId} request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!isRecord(payload)) {
    throw new Error(`Bangumi API subject ${subjectId} response must be a JSON object`);
  }
  return payload;
}

export function bangumiApiSubjectUrl(subjectId: string | number, baseUrl = "https://api.bgm.tv"): string {
  return `${baseUrl.replace(/\/$/, "")}/v0/subjects/${encodeURIComponent(String(subjectId))}`;
}

function bangumiApiHeaders(options: Pick<BangumiApiProviderOptions, "token" | "userAgent">): Record<string, string> {
  return {
    accept: "application/json",
    ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  };
}

export async function* readBangumiArchiveSubjects(
  filePath: string,
  options: Pick<BangumiArchiveFileOptions, "format"> = {}
): AsyncIterable<BangumiArchiveSubject> {
  const format = resolveArchiveFormat(filePath, options.format ?? "auto");
  if (format === "jsonl") {
    yield* readBangumiArchiveJsonLines(filePath);
    return;
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  yield* subjectsFromBangumiArchiveJson(parsed);
}

export function subjectsFromBangumiArchiveJson(value: unknown): BangumiArchiveSubject[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.subjects)
      ? value.subjects
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : isRecord(value) && Array.isArray(value.data)
          ? value.data
          : undefined;

  if (!items) {
    throw new Error("Bangumi Archive JSON must be an array or an object with subjects/items/data array");
  }

  return items.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Bangumi Archive item ${index + 1} must be an object`);
    }
    return item;
  });
}

export function normalizeBangumiArchiveSubject(
  subject: BangumiArchiveSubject,
  options: BangumiArchiveNormalizeOptions = {}
): NormalizedMediaCandidate | null {
  const type = numberFrom(subject.type);
  if (type !== undefined && type !== BANGUMI_ANIME_SUBJECT_TYPE) {
    return null;
  }

  const subjectId = stringFrom(subject.id);
  if (!subjectId) {
    throw new Error("Bangumi Archive subject is missing id");
  }

  const name = stringFrom(subject.name);
  const nameCn = stringFrom(subject.name_cn);
  const title = nameCn || name;
  if (!title) {
    throw new Error(`Bangumi subject ${subjectId} is missing title`);
  }

  const titleSourceField = nameCn ? "name_cn" : "name";
  const providerRef: ProviderRef = {
    provider: BANGUMI_PROVIDER_KEY,
    entity: BANGUMI_SUBJECT_ENTITY,
    id: subjectId
  };
  const lastSync = options.lastSync ?? DEFAULT_LAST_SYNC;
  const rawRef = options.rawRef;
  const episodeCountField = subject.eps !== undefined ? "eps" : subject.total_episodes !== undefined ? "total_episodes" : "unknown";
  const runtimeValue = runtimeFromSubject(subject);

  return {
    kind: "anime",
    providerRef,
    aliases: aliasesFromTitles({ name, nameCn }),
    metadata: {
      title,
      ...(stringFrom(subject.summary) ? { summary: stringFrom(subject.summary) } : {}),
      episode_count: numberFrom(subject.eps) ?? numberFrom(subject.total_episodes) ?? 0,
      runtime: runtimeValue.value,
      ...(stringFrom(subject.date) ? { air_date: { start: stringFrom(subject.date) } } : {}),
      ...(imagesFrom(subject.images) ? { images: imagesFrom(subject.images) } : {}),
      ...(ratingFrom(subject.rating) ? { ratings: ratingFrom(subject.rating) } : {})
    },
    provenance: {
      "metadata.title": provenance({
        sourceField: titleSourceField,
        lastSync,
        providerRef,
        rawRef,
        rule: `bangumi.${titleSourceField} -> metadata.title`
      }),
      "metadata.episode_count": provenance({
        sourceField: episodeCountField,
        lastSync,
        providerRef,
        rawRef,
        rule: `bangumi.${episodeCountField} -> metadata.episode_count`
      }),
      "metadata.runtime": provenance({
        sourceField: runtimeValue.sourceField,
        lastSync,
        providerRef,
        rawRef,
        rule: `bangumi.${runtimeValue.sourceField} -> metadata.runtime`
      })
    }
  };
}

function aliasesFromTitles(input: { name?: string; nameCn?: string }): NormalizedAliasCandidate[] {
  const aliases: NormalizedAliasCandidate[] = [];
  const seen = new Set<string>();

  function add(alias: NormalizedAliasCandidate): void {
    const key = alias.value.normalize("NFKC").trim().toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    aliases.push(alias);
  }

  if (input.nameCn) {
    add({ value: input.nameCn, language: "zh-Hans", type: "localized", source: BANGUMI_PROVIDER_KEY, confidence: 0.98 });
  }
  if (input.name) {
    add({ value: input.name, language: "ja", type: "official", source: BANGUMI_PROVIDER_KEY, confidence: 0.95 });
  }

  return aliases;
}

function provenance(input: {
  sourceField: string;
  lastSync: string;
  providerRef: ProviderRef;
  rawRef?: string;
  rule: string;
}) {
  return {
    source: BANGUMI_PROVIDER_KEY,
    sourceField: input.sourceField,
    lastSync: input.lastSync,
    rule: input.rule,
    providerRef: input.providerRef,
    ...(input.rawRef ? { rawRef: input.rawRef } : {})
  };
}

function runtimeFromSubject(subject: BangumiArchiveSubject): { value: number; sourceField: string } {
  const direct = parseRuntimeMinutes(stringFrom(subject.duration));
  if (direct !== undefined) {
    return { value: direct, sourceField: "duration" };
  }

  const infoboxDuration = infoboxText(subject.infobox, ["话长", "每话时长", "片长", "duration"]);
  const fromInfobox = parseRuntimeMinutes(infoboxDuration);
  if (fromInfobox !== undefined) {
    return { value: fromInfobox, sourceField: "infobox.duration" };
  }

  return { value: 0, sourceField: "unknown" };
}

function parseRuntimeMinutes(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const hourMinute = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hourMinute) {
    return Number(hourMinute[1]) * 60 + Number(hourMinute[2]);
  }

  const minutes = value.match(/(\d+)\s*(?:m|min|mins|minute|minutes|分钟|分)/i);
  if (minutes) {
    return Number(minutes[1]);
  }

  const firstNumber = value.match(/\d+/);
  return firstNumber ? Number(firstNumber[0]) : undefined;
}

function imagesFrom(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const images: Record<string, string> = {};
  for (const [key, image] of Object.entries(value)) {
    if (typeof image === "string" && image.trim()) {
      images[key] = image;
    }
  }
  return Object.keys(images).length > 0 ? images : undefined;
}

function ratingFrom(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const score = numberFrom(value.score);
  return score === undefined ? undefined : { bangumi: score };
}

function infoboxText(value: unknown, keys: readonly string[]): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const key = stringFrom(item.key)?.toLowerCase();
    if (!key || !normalizedKeys.has(key)) {
      continue;
    }
    return textFromInfoboxValue(item.value);
  }
  return undefined;
}

function textFromInfoboxValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textFromInfoboxValue).filter(Boolean).join(" ") || undefined;
  }
  if (isRecord(value)) {
    return textFromInfoboxValue(value.v ?? value.value ?? value.name);
  }
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveArchiveFormat(filePath: string, format: "auto" | "json" | "jsonl"): "json" | "jsonl" {
  if (format !== "auto") {
    return format;
  }

  const extension = extname(filePath).toLowerCase();
  return extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "json";
}

async function* readBangumiArchiveJsonLines(filePath: string): AsyncIterable<BangumiArchiveSubject> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Bangumi Archive JSONL line ${lineNumber} must be an object`);
    }
    yield parsed;
  }
}

async function* iterate<T>(values: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in Object(values)) {
    yield* values as AsyncIterable<T>;
    return;
  }
  yield* values as Iterable<T>;
}
