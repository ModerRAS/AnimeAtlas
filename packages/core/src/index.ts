import { createHash } from "node:crypto";

export const MEDIA_ID_PATTERN = /^media-\d{6}$/;
export const SERIES_ID_PATTERN = /^series-\d{6}$/;
export const EPISODE_ID_PATTERN = /^episode-\d{6}$/;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

export function isSeriesId(value: unknown): value is string {
  return typeof value === "string" && SERIES_ID_PATTERN.test(value);
}

export function isEpisodeId(value: unknown): value is string {
  return typeof value === "string" && EPISODE_ID_PATTERN.test(value);
}

export function mediaIdNumber(value: string): number {
  if (!isMediaId(value)) {
    throw new Error(`Invalid media id: ${value}`);
  }
  return Number(value.slice("media-".length));
}

export function formatMediaId(value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid media id number: ${value}`);
  }
  return `media-${String(value).padStart(6, "0")}`;
}

export function nextMediaId(existingIds: Iterable<string>): string {
  let max = 0;
  for (const id of existingIds) {
    max = Math.max(max, mediaIdNumber(id));
  }
  return formatMediaId(max + 1);
}

export function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, "en"));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export type InstallmentContext = {
  season?: number;
  part?: number;
  cour?: number;
};

export type CatalogSeries = {
  id: string;
  title: string;
};

export type CatalogMedia = {
  id: string;
  seriesId: string;
  title: string;
  installment: InstallmentContext;
};

export type CatalogAlias = {
  value: string;
  target: { type: "series"; id: string } | { type: "media"; id: string };
};

export type EpisodeNumber = {
  namespace: string;
  value: number;
};

export type CatalogEpisode = {
  id: string;
  mediaId: string;
  providerEpisodeId?: string;
  numbers: EpisodeNumber[];
};

export type Catalog = {
  series: CatalogSeries[];
  media: CatalogMedia[];
  aliases: CatalogAlias[];
  episodes?: CatalogEpisode[];
};

export type ResolveRequest = {
  titles: string[];
  season?: number;
  part?: number;
  cour?: number;
};

export type ResolveResult =
  | { status: "resolved"; media: CatalogMedia; evidence: string[] }
  | { status: "ambiguous"; candidates: CatalogMedia[]; evidence: string[] }
  | { status: "unresolved"; evidence: string[] };

export function resolveCatalog(catalog: Catalog, request: ResolveRequest): ResolveResult {
  const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
  const candidates = new Map<string, CatalogMedia>();
  const evidence: string[] = [];

  for (const title of request.titles) {
    const normalized = normalizeAlias(title);
    let matched = false;
    for (const alias of catalog.aliases) {
      if (normalizeAlias(alias.value) !== normalized) continue;
      matched = true;
      if (alias.target.type === "media") {
        const media = mediaById.get(alias.target.id);
        if (media) candidates.set(media.id, media);
      } else {
        for (const media of catalog.media) {
          if (media.seriesId === alias.target.id) candidates.set(media.id, media);
        }
      }
    }
    if (matched) evidence.push(`alias:${normalized}`);
  }

  let filtered = [...candidates.values()];
  if (request.season !== undefined) {
    filtered = filtered.filter((media) => media.installment.season === request.season);
    evidence.push(`season:${request.season}`);
  }
  if (request.part !== undefined) {
    filtered = filtered.filter((media) => media.installment.part === undefined || media.installment.part === request.part);
    evidence.push(`part:${request.part}`);
  }
  if (request.cour !== undefined) {
    filtered = filtered.filter((media) => media.installment.cour === undefined || media.installment.cour === request.cour);
    evidence.push(`cour:${request.cour}`);
  }

  filtered.sort((a, b) => a.id.localeCompare(b.id));
  if (filtered.length === 1) return { status: "resolved", media: filtered[0], evidence };
  if (filtered.length > 1) return { status: "ambiguous", candidates: filtered, evidence };
  return { status: "unresolved", evidence };
}

export function parseInstallmentContext(value: string): InstallmentContext {
  const season = firstNumber(value, [
    /(?:season|s)\s*0*(\d+)/i,
    /0*(\d+)(?:st|nd|rd|th)\s*season/i,
    /第\s*0*(\d+)\s*季/u
  ]);
  const part = firstNumber(value, [/(?:part|pt)\s*0*(\d+)/i, /第\s*0*(\d+)\s*(?:部|部分)/u]);
  const cour = firstNumber(value, [/(?:cour)\s*0*(\d+)/i, /0*(\d+)(?:st|nd|rd|th)\s*cour/i]);
  return {
    ...(season === undefined ? {} : { season }),
    ...(part === undefined ? {} : { part }),
    ...(cour === undefined ? {} : { cour })
  };
}

export type ParsedEpisodeMapping = {
  raw: string;
  numbers: EpisodeNumber[];
};

export function parseEpisodeMapping(value: string): ParsedEpisodeMapping {
  const numbers: EpisodeNumber[] = [];
  const consumed = new Set<number>();
  const patterns: Array<[string, RegExp]> = [
    ["bangumi:ep", /\bep\s*[:=#]?\s*0*(\d+)\b/gi],
    ["bangumi:sort", /\bsort\s*[:=#]?\s*0*(\d+)\b/gi],
    ["series:absolute", /(?:总|總|全系列)\s*(?:第)?\s*0*(\d+)\s*(?:集|话|話)?/gu],
    ["media:local", /(?:第\s*)?0*(\d+)\s*(?:集|话|話)/gu]
  ];

  for (const [namespace, pattern] of patterns) {
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? 0;
      if ([...Array(match[0].length).keys()].some((offset) => consumed.has(start + offset))) continue;
      const numeric = Number(match[1]);
      if (!Number.isInteger(numeric)) continue;
      numbers.push({ namespace, value: numeric });
      for (let index = start; index < start + match[0].length; index += 1) consumed.add(index);
    }
  }

  for (const match of value.matchAll(/\d+/g)) {
    const start = match.index ?? 0;
    if ([...Array(match[0].length).keys()].some((offset) => consumed.has(start + offset))) continue;
    numbers.push({ namespace: "release:observed", value: Number(match[0]) });
  }

  const unique = new Map(numbers.map((number) => [`${number.namespace}:${number.value}`, number]));
  return { raw: value, numbers: [...unique.values()] };
}

export type EpisodeMatchResult =
  | { status: "resolved"; episode: CatalogEpisode }
  | { status: "ambiguous"; candidates: CatalogEpisode[] }
  | { status: "unresolved" };

export function matchEpisodeNumbers(
  mediaId: string,
  parsed: ParsedEpisodeMapping,
  episodes: readonly CatalogEpisode[]
): EpisodeMatchResult {
  const candidates = episodes.filter((episode) => {
    if (episode.mediaId !== mediaId) return false;
    return parsed.numbers.every((observed) => episode.numbers.some((known) => {
      if (observed.namespace === "release:observed") return known.value === observed.value;
      const equivalent = observed.namespace === "media:local"
        ? new Set(["media:local", "bangumi:ep"])
        : observed.namespace === "series:absolute"
          ? new Set(["series:absolute", "bangumi:sort"])
          : new Set([observed.namespace]);
      return equivalent.has(known.namespace) && known.value === observed.value;
    }));
  });

  if (candidates.length === 1) return { status: "resolved", episode: candidates[0] };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unresolved" };
}

function firstNumber(value: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}
