# Validation and Index Generation Design

This document defines the validation, generation, and GitHub automation guardrails for AnimeAtlas.

For repository boundaries, data ownership, provider capabilities, Bangumi mode separation, and provenance shape, see [Repository Architecture](./repository-architecture.md).
For record families and normalized data structure, see [Schema-First Architecture](./schema-first-architecture.md).
If this document conflicts with those architecture docs, the repository and schema docs win.

## Scope

This phase covers:
- validation of approved contribution records
- validation of normalized media data
- deterministic generated artifact rules
- GitHub Action safety gates
- auditability requirements for issue-driven and provider-driven updates

This phase does not define:
- provider-specific scraper implementation details
- application UI behavior
- long-term entity modules beyond media

## Artifact Classes

The pipeline works across four committed artifact classes plus optional local runtime scratch:

1. `source/`
   - reviewed machine-readable contribution records, resolutions, and manifests
   - durable human input that is not safely derivable from provider fetches alone

2. `raw/<provider>/`
   - optional raw provider responses or normalized extracts
   - never manually edited

3. `db/`
   - published normalized database snapshot
   - internal media identities, unified metadata, aliases, external refs, and relations

4. `generated/`
   - deterministic indexes, stats, and manifests
   - never manually edited

Optional local runtime scratch may exist outside these committed artifact classes, but rebuild correctness must not depend on hidden operator state.

## Recommended Layout

This document assumes the workspace boundaries and source-data model defined in [Repository Architecture](./repository-architecture.md).

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
  <provider>/
    media/
      *.json

db/
  media/
    media-000001.json
  relations/
    media-000001.json

generated/
  indexes/
    aliases/
      exact.json
      tokens.json
      ambiguities.json
    provider-ids/
      <provider>.json
    relations/
      media.json
  stats/
    summary.json
    providers.json
  manifests/
    build.json
    content-hashes.json
```

Rules:
- `source/` is the reviewed human-input layer for contribution records, resolutions, and reproducibility manifests.
- `db/` is committed output from the shared pipeline, not the preferred hand-edit surface.
- `generated/` is fully reproducible and always regenerated from `db/`.
- `raw/` is optional, but if present it must pass integrity checks and remain machine-written.
- provider names come from descriptors and source data, not hardcoded validation branches.

## Core Validation Principles

The pipeline should guarantee that:
- contribution records are structurally valid before they can mutate data
- internal media IDs remain stable and unique
- provider external references never map one external ID to multiple internal IDs
- normalized metadata stays provider-neutral
- provenance exists for normalized fields
- generated artifacts are deterministic and reproducible
- GitHub Actions cannot commit partial or stale output

## Internal and External ID Rules

Internal IDs:
- use stable opaque IDs such as `media-000001`
- validate format and uniqueness
- never derive identity from provider ID strings

External IDs:
- are provider-owned reference strings
- are unique only within `(entity_type, provider, external_id)`
- remain external references, never primary keys
- should not be lowercased unless the provider contract explicitly says IDs are case-insensitive

This must be a hard invariant:
- one provider external ID points to exactly one internal media ID

## Unified Metadata Rules

Normalized data must use unified field names only.

Validation should fail if published metadata leaks provider-native field names or shapes into consumer-facing records.

Examples of required normalization:
- TMDB `episode_run_time` -> `runtime`
- Bangumi `eps` -> `episode_count`
- AniDB `episodecount` -> `episode_count`

The validator should treat provider-specific field names inside normalized `db/` media records as schema failures.

## Provenance Rules

Every normalized field needs provenance and `last_sync`.

Recommended model:
- plain normalized fields in the metadata body
- `_meta.last_sync` for provider-level sync summaries
- `_meta.providers` as a field-path map keyed by normalized field path

Validation should require:
- every required normalized field has a matching `_meta.providers` entry keyed by normalized field path
- every provider referenced from field provenance has a matching `_meta.last_sync` entry
- raw references, if present, point to a valid raw artifact or a valid external raw locator
- provenance entries use normalized field paths, not provider-native field names
- field provenance entries include enough trace data to identify provider, external ID, source field or raw path, and the sync event that produced the normalized value

The validator should fail missing provenance for required fields because auditability is a core contract, not a nice-to-have.

## Validation Stages

Validation should run in layers so failures stay debuggable.

### Stage 0: contribution record validation

Fail fast on:
- malformed issue-derived JSON
- missing approval metadata
- missing issue number or maintainer decision data
- unsupported operation types
- references to unknown entity kinds

This stage protects the GitHub Issue workflow before any data mutation occurs.

### Stage 1: file, schema, and canonical JSON checks

Fail on:
- invalid JSON
- schema violations
- missing required fields
- duplicate object keys if the parser can surface them
- non-canonical generated JSON formatting

Recommended baseline:
- strict schema validation
- stable JSON serializer contract
- LF endings and trailing newline for generated artifacts

### Stage 2: identity graph integrity

Fail on:
- duplicate internal IDs
- broken relations pointing to missing internal IDs
- malformed lifecycle or entity-kind values
- cycles in edge types that must be acyclic

Relationship rules should be data-driven by relation type, not by provider.

### Stage 3: alias integrity

Fail on:
- malformed alias records
- alias rows pointing to missing media IDs
- duplicate alias rows for the same target after normalization using the tuple:
  - entity type
  - target ID
  - normalized alias
  - language
  - alias type

Warn, but do not fail, on:
- one normalized alias mapping to multiple internal IDs
- suspicious invisible characters stripped during normalization

Ambiguity is real and should surface as review data, not silent mutation.

### Stage 4: external reference integrity

Fail on:
- duplicate external ID assignments within `(entity_type, provider, external_id)`
- the same provider ID mapped to multiple internal media IDs
- malformed provider namespace values
- metadata or raw-cache records referencing missing internal IDs

This is a hard identity safety boundary.

### Stage 5: normalized metadata integrity

Fail on:
- required unified fields missing from records that claim a completeness level
- invalid date ranges
- invalid enum values for format, status, or rating fields owned by the unified schema
- provider-native field names leaking into normalized metadata
- relations embedded in metadata that reference missing records

Keep metadata completeness separate from identity validity. A media identity may exist before metadata is complete.

### Stage 6: provenance integrity

Fail on:
- missing `_meta.last_sync` entries for referenced providers
- missing `_meta.providers` entries for required normalized fields
- field provenance entries missing provider key, external ID, source field or raw path, or sync event reference
- provenance entries pointing to unknown normalized field paths
- raw references that claim local cache but point to missing files

Warn on:
- optional raw cache omitted for providers where local raw retention is disabled
- stale provider sync timestamps that exceed configured freshness budgets

### Stage 7: generated artifact verification

After generation, fail on:
- generated files differing from repository state after rebuild
- unstable key or array ordering between repeated runs
- indexes referencing missing internal IDs
- duplicate keys in provider ID lookup maps
- manifests missing schema or generator version information

This is the main guardrail against stale or partial commits.

### Stage 8: smoke query verification

Run a small deterministic query suite against generated indexes.

Checks:
- exact alias lookup returns expected IDs
- ambiguous alias lookup returns multiple candidates where expected
- provider ID lookup resolves known mappings
- relation adjacency lookup returns expected neighbors for fixtures

Keep this suite small. It validates index semantics, not end-user application behavior.

## Generated Artifact Rules

Keep generated outputs simple, deterministic, and consumer-friendly.

### Alias exact index

File:
- `generated/indexes/aliases/exact.json`

Purpose:
- exact lookup from normalized alias key to candidate media IDs

Rules:
- key is the generated search key, not raw submitted text
- candidate lists are sorted deterministically
- values include only normalized consumer-safe fields needed for lookup

### Alias token index

File:
- `generated/indexes/aliases/tokens.json`

Purpose:
- cheap offline candidate narrowing

Rules:
- postings are deduplicated
- tokens are normalized by the shared normalization library
- postings are sorted by internal ID

### Ambiguity report

File:
- `generated/indexes/aliases/ambiguities.json`

Purpose:
- surface ambiguous aliases without corrupting identity mappings

Rules:
- never pick a fake winner just to keep the file small
- include enough context for maintainers to review collisions

### Provider ID index

File pattern:
- `generated/indexes/provider-ids/<provider>.json`

Purpose:
- resolve provider IDs to internal media IDs offline without scanning full data

Rules:
- one provider file per provider
- provider discovery is data-driven
- entity type is explicit in the file shape for future expansion

### Relation adjacency index

File:
- `generated/indexes/relations/media.json`

Purpose:
- fast local traversal of media relationships

### Stats and manifests

Files:
- `generated/stats/summary.json`
- `generated/stats/providers.json`
- `generated/manifests/build.json`
- `generated/manifests/content-hashes.json`

Purpose:
- auditability and rebuild traceability

Minimum manifest contents:
- schema version
- generator version
- build timestamp
- source commit
- applied contribution record IDs
- provider sync checkpoints used for the build

## Determinism Contract

All generated artifacts must be byte-stable.

Rules:
- stable file discovery order
- stable object key ordering
- stable array sorting
- stable newline policy
- canonical JSON serialization
- no timestamp fields inside generated consumer indexes unless explicitly versioned in manifests

Recommended command contract:
- `pnpm validate`
- `pnpm build:indexes`
- `pnpm check:generated`

`check:generated` should rebuild in a clean workspace and fail if committed `generated/` output differs.

## GitHub Actions Guardrails

Use one shared pipeline locally and in GitHub Actions.

### Workflow: pull-request-validation

Checks:
1. install dependencies
2. validate schemas and contribution records touched by the change
3. validate identity, alias, external reference, metadata, and provenance integrity
4. rebuild generated artifacts
5. fail if `generated/` is stale
6. upload warnings and manifests as artifacts

### Workflow: approved-issue-updater

Trigger:
- maintainer-applied approval label on a structured issue

Checks and actions:
1. parse issue body into a contribution record
2. validate that record
3. apply mutation through the shared updater
4. run the full validation stack
5. regenerate artifacts
6. verify deterministic cleanliness
7. commit `source/`, `db/`, and `generated/` changes together
8. comment with summary and close the issue

Important rule:
- the workflow must never commit contribution or data mutations without regenerated artifacts and a clean validation pass

### Workflow: provider-sync

Trigger:
- schedule or manual dispatch

Checks and actions:
1. load provider checkpoints
2. run incremental updates for enabled providers
3. validate touched identities and metadata
4. regenerate affected artifacts
5. publish manifests and sync reports

### Workflow: rebuild-from-source

Trigger:
- manual dispatch or maintenance release

Checks and actions:
1. run bulk imports for supported providers
2. rebuild normalized snapshot
3. regenerate all artifacts
4. compare against expected contract and publish mismatch reports

## Community Contribution Safety

Community contribution automation should assume untrusted input.

Required safeguards:
- structured issue forms only
- approval label required before mutation
- parser emits a machine-readable contribution record before touching published data
- contribution records are schema-validated
- updater can touch only allowed paths
- full validation and deterministic regeneration run before commit
- action comments link issue number, affected media IDs, and resulting commit

Contributors propose data changes. Maintainers approve intent. Automation performs the actual mutation.

## Auditability Requirements

Every automated update should leave enough evidence to answer:
- which issue or provider sync caused the change
- which media IDs were affected
- which fields changed
- which providers supplied the winning values
- whether raw evidence exists and where it lives
- which generator and schema versions produced the final snapshot

This is the standard for long-term maintenance, not an optional reporting layer.
