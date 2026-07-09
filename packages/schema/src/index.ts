export const schemaFamilies = {
  mediaIdentity: "media-identity/v1",
  mediaAliases: "media-aliases/v1",
  mediaMetadata: "media-metadata/v1",
  generatedAliasIndex: "generated-alias-index/v1",
  generatedProviderIdIndex: "generated-provider-id-index/v1",
  generatedSearchIndex: "generated-search-index/v1",
  generatedStats: "generated-stats/v1",
  buildManifest: "build-manifest/v1",
  providerManifest: "provider-manifest/v1",
  providerManifestList: "provider-manifest-list/v1",
  contribution: "contribution/v1"
} as const;

export type SchemaFamily = (typeof schemaFamilies)[keyof typeof schemaFamilies];
