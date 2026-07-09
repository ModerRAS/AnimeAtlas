# Repository Architecture

This project is an open Anime Identity & Metadata Database for offline anime scraping.

Primary goal:
- given any anime title, alias, or external provider ID, resolve one internal anime identity and return unified metadata without repeated online API requests

This is infrastructure, not a product application. The repository should optimize for deterministic rebuilds, provider independence, provenance, auditability, schema evolution, and long-term maintainability.

Related documents:
- [Architecture Overview](./architecture.md)
- [Schema-First Architecture](./schema-first-architecture.md)
- [Validation and Index Generation Design](./validation-and-index-generation.md)

## Monorepo Topology

The repository should be a pnpm workspace monorepo with a hard split between reusable libraries, operational applications, and published data artifacts.

```text
apps/
  cli/
  github-action/
  viewer/

packages/
  core/
  schema/
  providers/
  provider-bangumi/
  provider-tmdb/
  provider-anidb/
  provider-myanimelist/
  provider-anilist/
  importer/
  validator/
  generator/

source/
  contributions/
  resolutions/
  manifests/

raw/
  bangumi/
    archive/
    api/
  tmdb/
  anidb/
  myanimelist/
  anilist/

db/
  media/
  relations/

generated/
  indexes/
  stats/

docs/
.github/workflows/
```

Root rules:
- the workspace root owns shared config only: `package.json`, `pnpm-workspace.yaml`, TypeScript base config, lint/format config, and top-level docs
- reusable domain logic lives only in `packages/`
- executable entrypoints and environment glue live only in `apps/`
- provider data and published database artifacts live outside code packages so rebuilds, diffs, and release artifacts stay inspectable
- GitHub workflow files orchestrate package entrypoints; they do not contain business logic

## Package Boundaries

`packages/core`
- provider-agnostic domain model
- internal ID rules for `media-000001` style IDs
- normalized entity primitives
- deterministic ordering, stable serialization, and provenance path vocabulary
- no HTTP clients, no provider SDKs, no GitHub-specific logic

`packages/schema`
- versioned schemas for `source/`, `raw/`, `db/`, and `generated/`
- schema compatibility rules and migration boundaries
- unified metadata field vocabulary consumed by all apps and packages

`packages/providers`
- provider contracts only
- capability interfaces: Search, Resolve IDs, Fetch Metadata, Fetch Images, Fetch Relations, Bulk Import, Incremental Update
- registry metadata describing which capabilities a provider implements
- no provider-specific field names and no normalization logic

`packages/provider-*`
- one workspace package per provider implementation
- examples now: Bangumi, TMDB, AniDB, MyAnimeList, AniList
- future additions such as IMDb, TVDB, Douban, Wikidata, and VNDB should arrive as new packages, not edits inside `core`
- each provider package exports only the capabilities it actually supports
- provider packages may depend on `core`, `schema`, and `providers`, but never on each other

`packages/importer`
- owns the import pipeline orchestration: Provider -> Downloader -> Normalizer -> Matcher -> Conflict Resolver -> Identity Database
- composes capability implementations from provider packages
- writes `raw/` and `db/` through shared storage contracts
- the only reusable library allowed to understand pipeline sequencing

`packages/validator`
- validates `source/`, `raw/`, `db/`, and `generated/`
- enforces determinism, identity integrity, provenance completeness, and schema compatibility
- must stay provider-independent; provider additions should not require validator branches

`packages/generator`
- builds reproducible outputs from `db/`
- owns generated search indexes, provider ID indexes, relation indexes, and statistics
- no network access and no provider-specific scraping logic

Boundary rule:
- `core`, `schema`, `validator`, and `generator` must not import concrete provider packages
- provider selection happens in `importer` and the apps that invoke it

## Application Boundaries

`apps/cli`
- maintainer and power-user interface
- runs full rebuilds, incremental syncs, validation, generation, and offline lookup commands
- the main local operator surface

`apps/github-action`
- automation wrapper for issue parsing, approved-label checks, rebuilds, validation, generation, and commit/close flow
- reuses the same package entrypoints as the CLI
- must not fork logic from the CLI or packages

`apps/viewer`
- read-only inspection surface for `db/` and `generated/`
- used to inspect identities, provider links, conflicts, provenance, and generated indexes
- never mutates repository data

## Provider System

Providers are first-class and capability-driven.

Rules:
- a provider is identified by a stable provider key and advertises a capability set
- capabilities are independent; a provider may implement any subset of Search, Resolve IDs, Fetch Metadata, Fetch Images, Fetch Relations, Bulk Import, and Incremental Update
- applications talk to capability contracts, not provider-specific classes or switch statements
- normalized metadata never exposes provider field names such as `episode_run_time`, `eps`, or `episodecount`; those are mapped to unified fields such as `runtime` and `episode_count`

Adding a provider should require:
1. a new `packages/provider-<name>` workspace package
2. schema updates only if the unified schema truly grows
3. app-level registration so the CLI or GitHub Action can invoke it

It should not require:
- edits to `core` for provider-specific behavior
- validator changes for provider names
- generated index format changes

## Bangumi Modes

Bangumi needs two independent import paths inside `packages/provider-bangumi`.

Bulk import mode:
- source: `https://github.com/bangumi/Archive`
- purpose: cold start, rebuild, disaster recovery, and large backfills
- preferred path for initializing the database
- raw payloads live under `raw/bangumi/archive/`
- import manifests in `source/manifests/` pin the archive version used for a rebuild

Incremental sync mode:
- source: `https://github.com/bangumi/api`
- purpose: ongoing updates and online synchronization
- raw payloads live under `raw/bangumi/api/`
- durable cursors or sync checkpoints that affect reproducibility belong in `source/manifests/`, not ad hoc local state

Design rule:
- archive rebuilds and API syncs share normalization and matching contracts, but they stay operationally separate so a full rebuild never depends on live API behavior and a small sync never rewrites archive history

## Data Directories and Ownership

`source/`
- contains durable inputs that are not safely derivable from provider fetches alone
- examples: approved issue-derived contribution records, manual merge or split decisions, canonical title resolutions, provider ID corrections, import manifests, and sync checkpoints that matter for reproducibility
- conceptually human-owned, but contributors should reach it through issue forms and automation rather than direct JSON editing
- maintainer edits are allowed, but only through reviewed workflow, never casual hand-editing in published files

`raw/`
- contains optional machine-written provider responses under `raw/<provider>/`
- never edited manually
- may be partial by provider or mode
- exists to support rebuilds, audits, and provenance without forcing repeat API requests

`db/`
- contains the normalized identity database with internal Media IDs, unified metadata, provider references, relations, and provenance
- machine-generated from `source/` plus provider inputs from `raw/` or live fetches
- published for consumers, but not edited directly
- this is the stable offline consumption layer for applications

`generated/`
- contains reproducible derivative artifacts such as alias indexes, provider ID indexes, search indexes, relation adjacency views, and statistics
- never edited manually
- always regenerated from `db/`

Ownership precedence:
1. `source/` records explicit editorial decisions
2. `raw/` records fetched provider evidence
3. `db/` is the resolved canonical database built from those inputs
4. `generated/` is a pure acceleration layer over `db/`

This ordering keeps human decisions explicit, provider evidence auditable, normalized data stable, and search artifacts disposable.

## Published Artifact Model

GitHub should be treated as the publication channel for the database, not the authoritative mutable working database.

That means:
- the committed repository is expected to contain publishable `source/`, `db/`, and `generated/` snapshots
- those snapshots must be reproducible from versioned tooling plus provider inputs and approved community contributions
- the authoritative state is the reproducible build graph, not a manually curated pile of JSON files
- rebuilds must be able to recreate `db/` and `generated/` without relying on hidden operator state

## Community Contribution Flow

Contributors should never edit database JSON directly.

Preferred workflow:
1. contributor opens a structured GitHub Issue
2. maintainer reviews and applies an approval label
3. `apps/github-action` parses the issue into `source/contributions/` or `source/resolutions/`
4. the action reruns importer, validator, and generator packages
5. if validation passes, the action commits updated `source/`, `db/`, and `generated/`
6. the action comments with the result and closes the issue

This keeps community input reviewable while preserving deterministic machine-owned artifacts.

## Provenance Model

Use plain unified fields in `db/` and attach field-level provenance in a lightweight `_meta.providers` map plus `_meta.last_sync`.

Why this is the better long-term choice:
- applications can consume stable normalized fields directly instead of reading wrapper objects like `title.value` and `runtime.value`
- provenance can evolve without reshaping every domain field in the schema
- arrays and nested objects stay readable; wrapper-per-value models become awkward and bloated for images, relations, titles, and future episode mappings
- storage overhead stays lower across millions of records
- generated indexes can read plain values while still tracing every normalized field back to provider evidence

Required provenance behavior:
- every normalized field path recorded in `_meta.providers` points to the provider source, provider external ID, source field or raw path, and the sync event that produced it
- `_meta.last_sync` records provider-level sync timestamps independently of field-level provenance
- conflict resolution records should identify whether the winning value came from raw provider evidence or explicit human resolution in `source/`

This keeps the public schema clean while preserving traceability.

## Long-Term Extension Reserve

Do not implement new entity families now, but reserve architecture for them.

The current boundaries should leave room for:
- Episode Mapping
- Season Mapping
- Movie Collections
- OVA and OAD relationships
- Character IDs
- Staff IDs
- Streaming Platform IDs
- Cross-media relationships

Preparation now should stay structural only:
- keep entity type explicit in schemas and indexes
- keep relation storage generic
- keep provider references generic
- keep generated indexes partitionable by entity type

That is enough to avoid repainting the architecture later without building unused modules today.
