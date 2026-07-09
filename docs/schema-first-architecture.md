# Schema-First Architecture

Repository layout, package boundaries, data ownership, and the chosen provenance model are defined in [Repository Architecture](./repository-architecture.md). If this document conflicts with that doc, the repository architecture doc wins.

AnimeAtlas is an open Anime Identity & Metadata Database.

The primary job is offline anime scraping: given a title, alias, or external provider ID, resolve one internal anime identity and return unified metadata without repeated online API requests. Alias handling is one feature inside that broader identity and metadata system, not the whole product.

## Design Position

This repository is infrastructure, not a user-facing application.

The architecture optimizes for:
- reproducibility from provider data plus approved community contributions
- deterministic builds and generated artifacts
- provider independence
- schema evolution and version compatibility
- long-term provenance and auditability
- minimal online fetches after import
- many years of maintenance and eventual millions of records

GitHub is the published database artifact, not the authoritative working database. The authoritative inputs are:
- provider data
- approved community contributions
- deterministic normalization, matching, and conflict-resolution rules

## Monorepo Layout

The workspace should separate reusable libraries from applications.

```text
packages/
  core/
  schema/
  providers/
    shared/
    bangumi/
    tmdb/
    anidb/
    myanimelist/
    anilist/
  importer/
  validator/
  generator/

apps/
  cli/
  github-action/
  viewer/

data/
  identity/
    media/
      media-000001.json
  provider-refs/
    media/
      media-000001.json
  aliases/
    media/
      media-000001.json
  metadata/
    media/
      media-000001.json
  raw/
    bangumi/
      media/
        253/
          2026-07-01T00-00-00Z.json
          manifest.json
  contributions/
    contrib-2026-000001.json

generated/
  indexes/
    aliases/
    providers/
    search/
    statistics/

state/
  providers/
    bangumi.incremental.json
```

Rules:
- the family boundaries matter more than the exact top-level directory names
- `packages/schema` owns JSON Schemas, schema manifests, and compatibility policy
- `packages/core` owns provider-independent domain rules and internal ID semantics
- `packages/providers/*` own only provider adapters and provider-specific normalizers
- `apps/*` consume unified data or orchestrate imports, but do not define schema
- `data/` here is illustrative shorthand for published source records committed to the database artifact
- `generated/` contains reproducible derived artifacts and is never manually edited
- `raw/` is optional provider retention; when present, it is never manually edited
- `state/` is maintainer runtime state, not part of the published database contract

## Internal Identity

Provider IDs are external references only.

AnimeAtlas uses its own internal media identity:
- stable ID format such as `media-000001`
- provider-neutral
- never derived from Bangumi, TMDB, AniDB, MyAnimeList, AniList, or any future provider ID
- one internal media ID may map to many provider IDs

The schema should validate the `media-` prefix and numeric suffix, but applications should still treat the value as opaque.

This keeps identity stable when:
- providers disagree
- a provider record is deleted or split
- a better match is discovered later
- new providers are added

## Provider System

Providers are first-class and capability-driven.

Core must not depend on provider-specific logic. Adding a provider should mean:
- adding a new provider package
- declaring its capabilities
- adding provider-specific normalization rules inside that provider package
- no changes to core schema families
- no hardcoded provider branching in consumers of unified metadata

Provider capabilities are independent:
- `search`
- `resolve_ids`
- `fetch_metadata`
- `fetch_images`
- `fetch_relations`
- `bulk_import`
- `incremental_update`

Not every provider supports every capability.

Representative provider manifest:

```json
{
  "schema_family": "provider-manifest",
  "schema_version": 1,
  "provider": "bangumi",
  "entity_types": ["media"],
  "capabilities": [
    "search",
    "resolve_ids",
    "fetch_metadata",
    "fetch_images",
    "fetch_relations",
    "bulk_import",
    "incremental_update"
  ],
  "priority": 100,
  "notes": {
    "bulk_import": "bangumi/archive",
    "incremental_update": "bangumi/api"
  }
}
```

Recommended initial providers:
- Bangumi
- TMDB
- AniDB
- MyAnimeList
- AniList

Future providers fit the same model:
- IMDb
- TVDB
- Douban
- Wikidata
- VNDB

## Bangumi Integration

Bangumi needs two separate import modes that feed the same downstream pipeline.

### Mode 1: Bulk Import via `bangumi/Archive`

Use this for:
- first initialization
- full rebuilds
- periodic baseline refreshes

Flow:
1. read a specific Archive snapshot
2. write optional raw payloads under `data/raw/bangumi/`
3. normalize Bangumi fields into provider-neutral candidate records
4. match or create internal `media-*` identities
5. write provider refs, aliases, metadata, and raw manifests
6. regenerate derived indexes

Characteristics:
- highest throughput
- reproducible from a named snapshot
- preferred baseline source for Bangumi

### Mode 2: Incremental Sync via `bangumi/api`

Use this for:
- updates after a bulk baseline exists
- online synchronization
- catching changed records between snapshot rebuilds

Flow:
1. read stored incremental cursor from maintainer state
2. call Bangumi API for changed subjects
3. write optional raw payloads under `data/raw/bangumi/`
4. run the same normalizer, matcher, and conflict resolver as bulk import
5. update provider refs and unified metadata
6. update cursor only after a successful deterministic write and validation pass
7. regenerate derived indexes

Characteristics:
- lower volume than archive import
- same normalized output contract as bulk import
- same provenance model as bulk import

The important design rule is that Bangumi import mode changes only the downloader step. The downstream schema, matcher, conflict resolver, metadata generator, and indexes stay the same.

## Import Pipeline

The import pipeline is:

`Provider -> Downloader -> Normalizer -> Matcher -> Conflict Resolver -> Identity Database -> Metadata Generator -> Generated Indexes`

Stage responsibilities:
- `Provider`: declares capabilities and provider-specific fetch semantics
- `Downloader`: acquires provider data from API, dump, archive, or export
- `Normalizer`: converts provider-specific fields into provider-neutral candidate fields
- `Matcher`: links provider records to an existing `media-*` or proposes a new one
- `Conflict Resolver`: chooses winners when providers disagree
- `Identity Database`: persists identity, provider refs, aliases, unified metadata, and optional raw manifests
- `Metadata Generator`: assembles consumer-facing metadata from resolved fields
- `Generated Indexes`: emits reproducible lookup and search artifacts

## Source Data Families

The source database should be split into distinct schema families.

### 1. Identity

Purpose:
- stable internal media identity
- lifecycle state
- future-safe structural relationships
- no provider-specific field names

Representative record:

```json
{
  "schema_family": "identity/media",
  "schema_version": 1,
  "media_id": "media-000001",
  "status": "active",
  "created_at": "2026-07-08T00:00:00Z",
  "created_by": "system:bangumi-archive-2026-07-01",
  "relationships": [
    {
      "type": "related",
      "target_media_id": "media-000321"
    }
  ]
}
```

Design notes:
- keep identity records small
- do not store raw provider payloads here
- do not store provider-specific metadata here
- reserve `relationships` for future season, collection, OVA/OAD, and cross-media modeling

### 2. Provider Refs

Purpose:
- external ID mappings owned by the internal media identity
- provider-specific record linkage without leaking provider fields into metadata
- one place to validate that a provider external ID maps to exactly one internal media ID

Representative record:

```json
{
  "schema_family": "provider-refs/media",
  "schema_version": 1,
  "media_id": "media-000001",
  "refs": [
    {
      "provider": "bangumi",
      "provider_entity_type": "subject",
      "external_id": "253",
      "canonical": true,
      "match_method": "provider_import",
      "first_seen_at": "2026-07-01T00:00:00Z",
      "last_verified_at": "2026-07-08T03:10:00Z",
      "raw_manifest_id": "raw-bangumi-253-2026-07-08"
    },
    {
      "provider": "anilist",
      "provider_entity_type": "anime",
      "external_id": "1",
      "canonical": true,
      "match_method": "cross_provider_match",
      "first_seen_at": "2026-07-02T12:00:00Z",
      "last_verified_at": "2026-07-08T03:10:00Z",
      "raw_manifest_id": "raw-anilist-1-2026-07-08"
    }
  ]
}
```

Design notes:
- provider refs are source data, not generated indexes
- generated provider lookup maps are derived from these records
- arrays are deliberate because some providers may require multiple linked IDs over time

### 3. Aliases

Purpose:
- searchable names and titles
- official, localized, translated, short, and community-supplied names
- no generated normalization keys stored in source data

Representative record:

```json
{
  "schema_family": "aliases/media",
  "schema_version": 1,
  "media_id": "media-000001",
  "aliases": [
    {
      "value": "Cowboy Bebop",
      "kind": "official",
      "language": "en",
      "source_type": "provider",
      "source_ref": {
        "provider": "anilist",
        "external_id": "1",
        "field": "title.english"
      },
      "confidence": 0.97
    },
    {
      "value": "カウボーイビバップ",
      "kind": "native",
      "language": "ja",
      "source_type": "provider",
      "source_ref": {
        "provider": "bangumi",
        "external_id": "253",
        "field": "name"
      },
      "confidence": 0.99
    },
    {
      "value": "星际牛仔",
      "kind": "localized",
      "language": "zh-Hans",
      "source_type": "community",
      "contribution_id": "contrib-2026-000014",
      "confidence": 0.9
    }
  ]
}
```

Design notes:
- `normalized` and `search_key` stay generated, not hand-authored
- community additions still enter through contribution records and automation
- aliases can be ambiguous globally; provider refs cannot

### 4. Unified Metadata

Purpose:
- provider-neutral consumer contract
- one normalized shape for CLI, GitHub Action, viewer, and downstream scrapers
- no provider-specific field names such as `eps`, `episode_run_time`, or `episodecount`

Representative record:

```json
{
  "schema_family": "metadata/media",
  "schema_version": 1,
  "media_id": "media-000001",
  "title": {
    "preferred": "Cowboy Bebop",
    "native": "カウボーイビバップ"
  },
  "format": "tv",
  "episode_count": 26,
  "runtime": 24,
  "airing": {
    "start_date": "1998-04-03",
    "end_date": "1999-04-24",
    "status": "finished"
  },
  "images": {
    "poster": {
      "path": "images/media-000001/poster.jpg"
    }
  },
  "relations": [
    {
      "type": "side_story",
      "media_id": "media-000002"
    }
  ],
  "_meta": {
    "record_last_merged_at": "2026-07-08T03:10:00Z",
    "providers": {
      "bangumi": {
        "last_sync": "2026-07-08T03:05:00Z",
        "raw_manifest_id": "raw-bangumi-253-2026-07-08"
      },
      "anilist": {
        "last_sync": "2026-07-08T03:07:00Z",
        "raw_manifest_id": "raw-anilist-1-2026-07-08"
      },
      "tmdb": {
        "last_sync": "2026-07-08T03:08:00Z",
        "raw_manifest_id": "raw-tmdb-30991-2026-07-08"
      }
    },
    "fields": {
      "/title/preferred": {
        "selected_from": {
          "provider": "anilist",
          "external_id": "1",
          "field": "title.romaji",
          "last_sync": "2026-07-08T03:07:00Z"
        }
      },
      "/episode_count": {
        "selected_from": {
          "provider": "bangumi",
          "external_id": "253",
          "field": "eps",
          "last_sync": "2026-07-08T03:05:00Z"
        }
      },
      "/runtime": {
        "selected_from": {
          "provider": "tmdb",
          "external_id": "30991",
          "field": "episode_run_time/0",
          "last_sync": "2026-07-08T03:08:00Z"
        }
      }
    }
  }
}
```

Design notes:
- applications consume unified fields only
- provider-specific names remain in raw payloads and provenance metadata
- metadata generation may merge multiple providers into one record
- missing fields are allowed when no provider supports that capability yet

### 5. Provenance

Purpose:
- trace every normalized field back to origin
- retain per-provider freshness
- support auditability and deterministic conflict resolution

AnimeAtlas should prefer a sidecar `_meta` provenance model over wrapping every value.

Recommended shape:
- `_meta.last_sync`: provider-level last sync timestamps
- `_meta.providers`: field-level winning source keyed by normalized field path
- optional resolver notes when multiple providers competed for the same field

Each field provenance entry should retain:
- provider key
- provider external ID
- normalized field path
- source field or raw path
- sync event or import run reference
- optional competing candidates when reviewability matters

Why the sidecar model is better long-term:
- unified metadata stays easy to consume because fields remain plain values
- schema evolution for provenance does not force every data field to change shape
- generated indexes can read source values directly without unwrapping nested objects
- records stay materially smaller at large scale
- provider freshness and audit data can grow independently from consumer-facing metadata

Value wrappers are heavier and would force every downstream consumer to unwrap nearly every field. That cost compounds across every record and every schema migration.

### 6. Raw Cache Manifests

Purpose:
- track raw provider payload retention under `raw/{provider}/`
- make metadata rebuilds possible without re-fetching when raw retention is enabled
- record fetch mode, source snapshot, checksums, and linkage to normalized records

Representative record:

```json
{
  "schema_family": "raw-cache-manifest",
  "schema_version": 1,
  "manifest_id": "raw-bangumi-253-2026-07-08",
  "provider": "bangumi",
  "provider_entity_type": "subject",
  "external_id": "253",
  "fetch_mode": "archive",
  "source": {
    "snapshot": "bangumi-archive-2026-07-01",
    "uri": "https://github.com/bangumi/Archive"
  },
  "fetched_at": "2026-07-08T03:05:00Z",
  "raw_path": "data/raw/bangumi/media/253/2026-07-08T03-05-00Z.json",
  "content_sha256": "sha256:9b4a...",
  "normalizer": "bangumi-subject-v1",
  "status": "active"
}
```

For incremental API sync, only `fetch_mode` and `source` change:

```json
{
  "schema_family": "raw-cache-manifest",
  "schema_version": 1,
  "manifest_id": "raw-bangumi-253-2026-07-09",
  "provider": "bangumi",
  "provider_entity_type": "subject",
  "external_id": "253",
  "fetch_mode": "incremental_api",
  "source": {
    "api": "https://github.com/bangumi/api",
    "cursor": "2026-07-09T00:00:00Z"
  },
  "fetched_at": "2026-07-09T01:20:00Z",
  "raw_path": "data/raw/bangumi/media/253/2026-07-09T01-20-00Z.json",
  "content_sha256": "sha256:17ce...",
  "normalizer": "bangumi-subject-v1",
  "status": "active"
}
```

Design notes:
- raw retention is optional, but manifest schema should stay stable
- raw payloads are never hand-edited
- manifests make it explicit which payload produced which normalized fields

### 7. Contribution Records

Purpose:
- turn GitHub issues into auditable structured change requests
- keep contributors out of hand-editing JSON
- preserve review and automation history

Representative record:

```json
{
  "schema_family": "contribution-record",
  "schema_version": 1,
  "contribution_id": "contrib-2026-000014",
  "source": {
    "type": "github_issue",
    "repository": "owner/AnimeAtlas",
    "issue_number": 214,
    "issue_url": "https://github.com/owner/AnimeAtlas/issues/214"
  },
  "status": "applied",
  "submitted_by": "octocat",
  "submitted_at": "2026-07-08T04:00:00Z",
  "approval": {
    "label": "approved",
    "approved_by": "maintainer",
    "approved_at": "2026-07-08T05:00:00Z"
  },
  "proposed_changes": [
    {
      "op": "add_alias",
      "media_id": "media-000001",
      "value": "星际牛仔",
      "language": "zh-Hans",
      "kind": "localized"
    }
  ],
  "applied": {
    "commit": "abc1234",
    "workflow_run_id": 987654321,
    "applied_at": "2026-07-08T05:10:00Z"
  }
}
```

Recommended workflow:
1. contributor opens a structured GitHub issue
2. maintainer reviews and applies approval label
3. GitHub Action parses the issue into a contribution record and source updates
4. validation and generation run
5. action commits source plus generated artifacts
6. issue is closed with an audit trail

### 8. Schema Versioning

Purpose:
- version each record family independently
- keep reader and writer compatibility explicit
- allow gradual migrations without breaking the whole database at once

Representative manifest:

```json
{
  "schema_family": "schema-manifest",
  "schema_version": 1,
  "schema_set": "animeatlas",
  "release": "2026.07",
  "families": {
    "identity/media": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    },
    "provider-refs/media": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    },
    "aliases/media": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    },
    "metadata/media": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    },
    "raw-cache-manifest": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    },
    "contribution-record": {
      "current_version": 1,
      "read_compatible": [1],
      "write_version": 1
    }
  }
}
```

Versioning rules:
- every record carries `schema_family` and `schema_version`
- every JSON Schema file is family-specific and versioned
- breaking changes bump the family version, not a global monolith version only
- generated artifacts may have their own schema families and versions
- compatibility policy lives in `packages/schema`

## Generated Artifacts

Generated artifacts are reproducible and never manually edited.

Expected generated families:
- alias exact index
- alias token or search index
- provider ID reverse lookup index
- statistics reports
- future relation or graph indexes

Representative provider lookup artifact:

```json
{
  "schema_family": "generated/provider-index",
  "schema_version": 1,
  "provider": "bangumi",
  "entity_type": "media",
  "mappings": {
    "253": "media-000001",
    "305": "media-000002"
  }
}
```

Representative alias exact index:

```json
{
  "schema_family": "generated/alias-exact-index",
  "schema_version": 1,
  "keys": {
    "cowboy bebop": ["media-000001"],
    "air": ["media-000300", "media-000301"]
  }
}
```

Everything under `generated/` must be byte-stable across rebuilds from the same source inputs.

## Long-Term Reserved Space

The first schema set should reserve room for, but not yet fully implement:
- episode mapping
- season mapping
- movie collections
- OVA/OAD relationships
- character IDs
- staff IDs
- streaming platform IDs
- cross-media relationships

Current design choices that keep that door open:
- internal IDs are provider-neutral
- provider refs are separate from identity
- metadata is normalized and provider-independent
- relationships are explicit records, not hardcoded special fields
- schema families are versioned independently
- generated indexes are derived, never authoritative

## Consumer Contract

Applications should consume AnimeAtlas in this order:
1. resolve by alias or provider ID through generated indexes
2. load the target `media-*` identity and unified metadata records
3. ignore raw payloads unless debugging, rebuilding, or auditing
4. ignore provider-specific field names entirely

That keeps CLI, GitHub Action, and viewer behavior consistent even as provider coverage grows.
