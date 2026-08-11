export const schemaFamilies = {
  seriesIdentity: "series-identity/v2",
  seriesAliases: "series-aliases/v2",
  mediaIdentity: "media-identity/v2",
  mediaAliases: "media-aliases/v2",
  episodeRecord: "episode-record/v2",
  mediaMetadata: "media-metadata/v1",
  generatedAliasIndex: "generated-alias-index/v1",
  generatedProviderIdIndex: "generated-provider-id-index/v1",
  generatedSearchIndex: "generated-search-index/v1",
  generatedStats: "generated-stats/v1",
  buildManifest: "build-manifest/v1",
  providerManifest: "provider-manifest/v1",
  providerManifestList: "provider-manifest-list/v1",
  generatedAliasCandidates: "generated-alias-candidates/v2",
  generatedEpisodeNumberIndex: "generated-episode-number-index/v2",
  contribution: "contribution/v2"
} as const;

export type SchemaFamily = (typeof schemaFamilies)[keyof typeof schemaFamilies];
