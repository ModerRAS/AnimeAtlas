# AnimeAtlas Architecture

Repository layout, package boundaries, data ownership, Bangumi mode separation, and the chosen provenance model are defined in [Repository Architecture](./repository-architecture.md). If this document conflicts with that doc, the repository architecture doc wins.

## Positioning

AnimeAtlas is an open Anime Identity & Metadata Database.

Its primary job is offline anime scraping:
- accept an anime title, alias, or external provider ID
- resolve a stable internal identity
- return unified metadata
- avoid repeated online API requests during normal use

Alias resolution matters, but it is only one capability inside a broader identity and metadata system.

## Design Priorities

The system should be treated as infrastructure, not as a consumer application.

Priorities, in order:
- reproducibility from providers plus approved community contributions
- deterministic builds and generated artifacts
- provider independence
- stable internal identities
- schema evolution and version compatibility
- auditability and provenance for every normalized value
- safe long-term maintenance at large scale

This design assumes many years of maintenance and eventual growth to millions of records.

## System Model

AnimeAtlas has four distinct layers:

1. provider inputs
   - raw provider payloads
   - provider import manifests
   - sync cursors and import checkpoints

2. normalized database
   - internal identities
   - external references
   - unified metadata
   - normalized relations
   - optional alias records

3. generated artifacts
   - alias and search indexes
   - provider ID indexes
   - statistics
   - build manifests

4. applications
   - CLI
   - GitHub Action updater
   - viewer and future readers

Applications consume normalized data and generated indexes only. They do not consume provider-specific field names or reach back into provider adapters.

## Monorepo Shape

Use a pnpm workspace monorepo with reusable libraries separated from applications.

Recommended layout:

```text
packages/
  core/
  schema/
  importer/
  validator/
  generator/
  providers/
    bangumi/
    tmdb/
    anidb/
    myanimelist/
    anilist/

apps/
  cli/
  github-action/
  viewer/

schemas/
  *.schema.json

contributions/
  issue-forms/
  approved/

state/
  providers/
  runs/

raw/
  <provider>/
    media/

data/
  identity/
    media/
  aliases/
    media/
  metadata/
    media/
  relations/
    media/

generated/
  indexes/
  stats/
  manifests/

docs/
```

Rules:
- `packages/*` own reusable logic.
- `apps/*` wire workflows and interfaces around those libraries.
- `data/` is the published normalized database snapshot.
- `generated/` is fully derived and never manually edited.
- `raw/` is optional provider cache and never manually edited.
- `contributions/approved/` stores machine-readable community contribution records derived from reviewed issues.
- `state/` is operational state for imports and automation, not a public consumption contract.

## Published Artifact vs Authority

GitHub should be treated as the published database artifact, not the authoritative working database.

The authoritative inputs are:
- provider snapshots and incremental feeds
- approved community contribution records
- normalization, matching, and conflict-resolution rules
- deterministic build scripts and schemas

The committed repository is a reproducible snapshot produced from those inputs.

That has two consequences:
- maintainers do not hand-edit normalized JSON as the primary workflow
- a full rebuild from provider inputs plus approved contribution records should reproduce the published snapshot, aside from intentionally optional raw-cache omissions

## Internal Identity Model

Provider IDs must never be the primary identity.

Use a stable internal media identifier such as:
- `media-000001`
- `media-000002`

Principles:
- one internal media ID can map to many provider references
- provider IDs are external references only
- internal IDs remain stable across provider changes, field normalization changes, or provider removals
- future entity families can reuse the same idea with their own namespaces without changing the media contract

Recommended separation:
- identity record: internal ID, lifecycle state, and external references
- metadata record: unified normalized fields for the media
- relation record: sequel, prequel, collection, adaptation, and future graph edges
- alias record: alternate names and lookup support

## Unified Metadata Contract

Applications should never consume provider-native field names.

All provider-specific payloads must be normalized into a unified schema. Examples:
- TMDB `episode_run_time` becomes `runtime`
- Bangumi `eps` becomes `episode_count`
- AniDB `episodecount` becomes `episode_count`

The normalized schema should be field-oriented, not provider-oriented.

That means:
- field names express domain meaning, not source naming
- record structure is stable even as providers are added or removed
- downstream tools can trust one metadata contract for offline scraping and lookup

## Provider System

Providers are first-class modules.

The provider contract should be capability-based rather than one large mandatory interface. Each provider declares which capabilities it supports.

Capability set:
- Search
- Resolve IDs
- Fetch Metadata
- Fetch Images
- Fetch Relations
- Bulk Import
- Incremental Update

Initial provider set:
- Bangumi
- TMDB
- AniDB
- MyAnimeList
- AniList

Future providers should fit the same model, for example:
- IMDb
- TVDB
- Douban
- Wikidata
- VNDB

Not every provider supports every capability.

Design rules:
- each capability is independently implementable
- core libraries depend on capability contracts, not provider internals
- provider registration is data-driven through descriptors or manifests
- adding a provider should require only a new provider package plus registration, not edits across core modules
- validation and generation discover providers from registered descriptors and source data, not hardcoded switches

Provider package responsibilities:
- authenticate and talk to the external source if needed
- convert provider payloads into provider-neutral intermediate records
- expose raw payload capture for traceability
- declare supported capabilities and limitations
- keep provider-native field names and provider reference parsing local to the provider package

The normalizer boundary is strict: downstream packages should see unified field names only.

Core responsibilities:
- orchestration
- normalized schemas
- matching and conflict resolution
- identity graph rules
- deterministic generation
- validation

## Import Pipeline

The canonical pipeline is:

Provider -> Downloader -> Normalizer -> Matcher -> Conflict Resolver -> Identity Database -> Metadata Generator -> Generated Indexes

Stage responsibilities:

### Provider
- exposes source-specific capability implementations
- declares provider name, version, and supported capabilities

### Downloader
- fetches provider payloads or snapshots
- writes optional raw cache under `raw/{provider}/`
- records run manifests, source URLs, fetch timestamps, and content hashes

### Normalizer
- converts provider payloads into unified intermediate records
- strips provider-native field naming from downstream data
- attaches provenance references to each normalized field candidate

### Matcher
- resolves provider records to existing internal media IDs where possible
- creates candidate matches, not final mutations
- works only against unified data and external reference sets
- should prefer deterministic evidence in this order: existing provider link, approved manual override, exact alias plus supporting metadata, relation-assisted candidate set, then new identity proposal or review

### Conflict Resolver
- applies deterministic policies when multiple sources disagree
- never silently merges external ID collisions
- either selects a winner with provenance or produces a reviewable conflict artifact
- resolves scalar field disagreements per field, merges set-like values with attribution, unions normalized relations, and keeps losing values in provenance rather than consumer-facing metadata

### Identity Database
- stores the resolved internal identity graph and unified metadata snapshot
- keeps external references separate from internal IDs

### Metadata Generator
- materializes consumer-facing normalized records from resolved identities
- emits stable JSON with stable ordering

### Generated Indexes
- emit alias lookup, provider ID lookup, search, stats, and audit manifests
- remain fully reproducible from normalized data plus schemas

## Bangumi Workflows

Bangumi needs two separate import modes.

### Mode 1: bulk import from Bangumi Archive

Use this for:
- initial bootstrap
- full rebuilds
- large repair or re-normalization passes

Workflow:
1. fetch or mount the Bangumi Archive snapshot
2. record archive version, source URL, fetch time, and content hash
3. store raw artifacts or normalized archive extracts under `raw/bangumi/` when enabled
4. normalize into unified intermediate records
5. run matching and conflict resolution against existing identities
6. rebuild normalized data and all generated indexes
7. publish a deterministic snapshot

This is the preferred path for initialization and recovery because it minimizes API drift and rate-limit dependence.

### Mode 2: incremental synchronization from Bangumi API

Use this for:
- ongoing updates
- online synchronization
- patching records between bulk rebuilds

Workflow:
1. load the last successful Bangumi sync checkpoint from `state/providers/bangumi`
2. fetch only changed entities from the Bangumi API
3. store raw API payloads under `raw/bangumi/` when enabled
4. normalize only changed records
5. re-run matching and conflict resolution for affected identities
6. regenerate affected normalized records and indexes
7. persist the new sync checkpoint and publish the updated snapshot

Rules:
- bulk and incremental flows share the same normalizer, matcher, resolver, validator, and generator
- incremental sync never writes provider-native values directly into published metadata
- a later bulk rebuild must converge with the same normalized contract
- Archive is the preferred rebuild baseline; API deltas layer on top when a fresher published snapshot is needed

## Provenance and `last_sync`

Every normalized field needs provenance and `last_sync`.

The long-term choice should be a sidecar metadata model, not wrapped scalar values.

Recommended record shape:
- normalized fields stay plain values for consumers
- `_meta.last_sync` stores provider-level sync timestamps
- `_meta.providers` stores field-level provenance keyed by normalized field path

Example responsibilities:
- `_meta.last_sync.bangumi`
- `_meta.last_sync.tmdb`
- `_meta.providers["title.primary"]`
- `_meta.providers["episode_count"]`
- `_meta.providers["images.poster.0.url"]`

Each field-level provenance entry should be able to carry:
- chosen provider
- provider external ID
- source field or source path
- raw payload reference if available
- resolution method or rule name
- sync event or import run reference
- optional competing candidates for audit logs or conflict reports

Why this is the better long-term choice:
- consumers read clean normalized JSON without unwrapping every value
- per-field provenance remains precise enough for audits and rebuilds
- schema evolution is easier because field types stay natural
- arrays and nested objects remain manageable
- storage overhead is much lower than wrapping every scalar and collection node
- provider freshness stays available without losing field-level traceability

Full value wrappers are too invasive for consumer ergonomics and schema stability. A provider-level `_meta.last_sync` map plus field-path keyed `_meta.providers` keeps the public schema clean while preserving traceability.

## Conflict Resolution Principles

Conflict resolution must be deterministic and auditable.

Rules:
- external ID collisions are always hard failures
- field conflicts are resolved per field, not by picking a single provider for the whole record
- each resolved value points to its provenance entry
- unresolved conflicts produce review artifacts instead of silent fallback
- resolver policies are keyed by unified field names and conflict classes, not by ad hoc provider branches spread through the codebase

The system should always be able to answer:
- what value was chosen
- which provider supplied it
- when it was last synced
- what competing values existed
- which rule selected the winner

## Community Contribution Workflow

Contributors never edit JSON directly.

Preferred workflow:
1. contributor opens a GitHub Issue using a structured form
2. maintainer reviews the request
3. maintainer applies an approval label
4. GitHub Action parses the issue into a normalized contribution record under `contributions/approved/`
5. updater applies the contribution to the workspace through the same importer and validator stack
6. generator rebuilds affected artifacts
7. action commits the updated snapshot and audit record
8. action comments with the result and closes the issue

Contribution safety rules:
- approval label is the gate for mutation
- issue parsing must be schema-validated before it can touch data
- community input becomes a structured contribution record, not an arbitrary patch
- every automated mutation emits an audit manifest linking commit, issue number, affected internal IDs, and generated files
- action permissions should be limited to the minimum needed to write the repository and comment on the issue

This keeps the human workflow safe while preserving full automation.

## GitHub Actions Design

Recommended workflows:

### 1. pull-request-validation

Purpose:
- validate changes to packages, schemas, data, raw cache, and generated artifacts

Checks:
- install workspace
- run schema validation
- run identity and metadata validation
- regenerate indexes and stats
- verify deterministic output
- fail if committed generated artifacts are stale

### 2. approved-issue-updater

Trigger:
- issue labeled with the approved contribution label

Responsibilities:
- parse the issue body into a machine-readable contribution record
- validate the record
- apply the update through the shared pipeline
- regenerate affected artifacts
- commit source plus generated changes together
- write an audit manifest
- comment and close on success

### 3. provider-sync

Trigger:
- schedule or manual dispatch

Responsibilities:
- run provider incremental updates
- regenerate affected normalized data and indexes
- open or commit a deterministic snapshot update
- publish sync report artifacts

### 4. rebuild-from-source

Trigger:
- manual dispatch or release maintenance

Responsibilities:
- run full bulk imports for supported providers
- rebuild the published snapshot from source inputs
- verify parity with expected schemas and artifact rules

Every workflow should call the same shared library and scripts. GitHub Actions should orchestrate; packages should do the work.

## Validation Strategy

Validation should be layered.

Required classes:
- contribution schema validation
- provider import manifest validation
- raw-cache integrity checks when raw is present
- identity graph integrity
- alias and search-key validation
- external reference uniqueness
- unified metadata schema validation
- provenance completeness checks
- deterministic generated artifact verification
- smoke queries against generated indexes

Warnings and errors should be separated:
- identity collisions and external ID collisions are hard errors
- ambiguous aliases are warnings plus generated review artifacts
- missing optional raw cache is not an error if provenance references remain valid

## Generated Artifact Strategy

Generated artifacts are never manually edited.

Recommended committed outputs:
- `generated/indexes/aliases/exact.json`
- `generated/indexes/aliases/tokens.json`
- `generated/indexes/aliases/ambiguities.json`
- `generated/indexes/provider-ids/<provider>.json`
- `generated/indexes/relations/media.json`
- `generated/stats/summary.json`
- `generated/stats/providers.json`
- `generated/manifests/build.json`
- `generated/manifests/content-hashes.json`

Rules:
- outputs are byte-stable
- file discovery order is stable
- object keys are stable
- arrays are stably sorted
- generated files use LF endings and trailing newlines
- generator version and schema version are recorded in manifests

The manifest layer exists for auditability:
- what inputs were used
- what generator version produced the output
- what contribution records were applied
- what provider sync checkpoints were used

## Long-Term Reserved Extension Points

Do not implement these now, but reserve architecture for them:
- Episode Mapping
- Season Mapping
- Movie Collections
- OVA and OAD relationships
- Character IDs
- Staff IDs
- Streaming Platform IDs
- cross-media relationships

The current design should keep those future additions possible by:
- keeping `entity_type` explicit
- keeping relations first-class
- keeping provider capabilities modular
- avoiding media-only assumptions in core validation and generation
- keeping external ID indexes per provider and entity type

## Summary

AnimeAtlas should behave like a reproducible data pipeline with published artifacts, not like a hand-maintained JSON repo.

The architecture centers on:
- stable internal media IDs
- provider-neutral unified metadata
- capability-based providers
- reproducible import and generation
- issue-driven community updates
- field-level provenance with consumer-friendly normalized records
- deterministic generated outputs suitable for long-term maintenance
