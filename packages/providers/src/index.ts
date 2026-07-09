export const providerCapabilities = [
  "search",
  "resolve_ids",
  "fetch_metadata",
  "fetch_images",
  "fetch_relations",
  "bulk_import",
  "incremental_update"
] as const;

export type ProviderCapability = (typeof providerCapabilities)[number];

export type ProviderKey = string;

export type ProviderRef = {
  provider: ProviderKey;
  entity: string;
  id: string;
};

export type ProviderManifest = {
  provider: ProviderKey;
  displayName: string;
  entityTypes: readonly ["anime", ..."anime"[]];
  capabilities: readonly ProviderCapability[];
};

export type ProviderSearchQuery = {
  query: string;
  language?: string;
  limit?: number;
};

export type ProviderSearchResult = {
  ref: ProviderRef;
  title: string;
  aliases?: readonly string[];
  score?: number;
};

export type NormalizedAliasCandidate = {
  value: string;
  language: string;
  type: "official" | "localized" | "romaji" | "nickname" | "alternative" | "legacy";
  source: ProviderKey;
  confidence: number;
};

export type NormalizedFieldProvenance = {
  source: ProviderKey;
  sourceField: string;
  lastSync: string;
  rule: string;
  providerRef: ProviderRef;
  rawRef?: string;
};

export type NormalizedMetadataCandidate = {
  title: string;
  summary?: string;
  genres?: readonly string[];
  studios?: readonly string[];
  season?: {
    year: number;
    name: "winter" | "spring" | "summer" | "fall" | "unknown";
  };
  episode_count: number;
  runtime: number;
  air_date?: {
    start?: string;
    end?: string;
  };
  images?: Record<string, string>;
  ratings?: Record<string, number>;
};

export type NormalizedMediaCandidate = {
  kind: "anime";
  providerRef: ProviderRef;
  aliases: readonly NormalizedAliasCandidate[];
  metadata: NormalizedMetadataCandidate;
  provenance: Record<string, NormalizedFieldProvenance>;
};

export interface SearchCapability {
  search(query: ProviderSearchQuery): Promise<readonly ProviderSearchResult[]>;
}

export interface ResolveIdsCapability {
  resolveIds(ref: ProviderRef): Promise<ProviderRef[]>;
}

export interface FetchMetadataCapability {
  fetchMetadata(ref: ProviderRef): Promise<NormalizedMediaCandidate>;
}

export interface FetchImagesCapability {
  fetchImages(ref: ProviderRef): Promise<Record<string, string>>;
}

export interface FetchRelationsCapability {
  fetchRelations(ref: ProviderRef): Promise<Array<{ type: string; target: ProviderRef }>>;
}

export interface BulkImportCapability {
  bulkImport(): AsyncIterable<NormalizedMediaCandidate>;
}

export interface IncrementalUpdateCapability {
  incrementalUpdate(since?: string): AsyncIterable<NormalizedMediaCandidate>;
}

export type AnimeAtlasProvider = {
  manifest: ProviderManifest;
  search?: SearchCapability["search"];
  resolveIds?: ResolveIdsCapability["resolveIds"];
  fetchMetadata?: FetchMetadataCapability["fetchMetadata"];
  fetchImages?: FetchImagesCapability["fetchImages"];
  fetchRelations?: FetchRelationsCapability["fetchRelations"];
  bulkImport?: BulkImportCapability["bulkImport"];
  incrementalUpdate?: IncrementalUpdateCapability["incrementalUpdate"];
};

export function providerRefKey(ref: ProviderRef): string {
  return `${ref.provider}:${ref.entity}:${ref.id}`;
}

export function supportsCapability(provider: AnimeAtlasProvider, capability: ProviderCapability): boolean {
  return provider.manifest.capabilities.includes(capability);
}
