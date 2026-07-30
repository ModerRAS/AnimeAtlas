# AnimeAtlas

[![Validate](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml/badge.svg)](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml)
[![Download SQLite](https://img.shields.io/badge/download-animeatlas.sqlite-00897B)](https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite)

An open anime identity and metadata database for offline lookup.

AnimeAtlas resolves an anime title, alias, or external provider ID (**Bangumi / TMDB / AniDB**) to a stable `media-*` identity and normalized metadata. It is built for scrapers, media managers, and library tools that need a local snapshot instead of repeated provider API calls.

## Download the database

A single-file SQLite snapshot is published under a **fixed download link** that always points at the latest build — the URL never changes between releases:

```
https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

```bash
curl -L -o animeatlas.sqlite \
  https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

The release itself is a single rolling release tagged `download`, overwritten on every publish. Because the URL is stable, you can pin it in scripts, docs, and package managers. The exact build is recorded inside the file in the `release_info` table, so you can always tell which snapshot you have even though the link never changes:

```sql
SELECT value FROM release_info WHERE key = 'version';
```

### SQLite schema

```text
media          (id, kind, title, summary, metadata_json, provenance_json)
aliases        (media_id, value, normalized, language, type, source, confidence)
provider_refs  (media_id, provider, entity, provider_id, provider_key)
search_tokens  (token, media_id)
release_info   (key, value)
```

Indexes: `aliases(normalized)`, `provider_refs(provider, entity, provider_id)`, `search_tokens(token)`.

- `media` — one row per anime identity. `metadata_json` holds the normalized fields (title, summary, genres, studios, season, episode count, runtime, air dates, …); `provenance_json` records which provider, source field, and rule produced each value.
- `aliases` — every alias for a media identity. `normalized` is the NFKC + trimmed + lowercased form used for exact matching.
- `provider_refs` — the mapping between internal `media-*` IDs and external provider IDs (e.g. `bangumi:subject:443666`). `provider_key` is unique.
- `search_tokens` — token index for fuzzy / token-based title search.

### Query examples

```sql
-- Resolve an alias. `normalized` stores NFKC + trimmed + lowercased text.
SELECT m.id, m.title
FROM aliases a JOIN media m ON m.id = a.media_id
WHERE a.normalized = 'sousou no frieren';

-- Look up a media identity by a Bangumi subject ID.
SELECT m.id, m.title, m.summary
FROM provider_refs p JOIN media m ON m.id = p.media_id
WHERE p.provider = 'bangumi' AND p.entity = 'subject' AND p.provider_id = '443666';

-- Pull normalized metadata and its provenance for one media identity.
SELECT metadata_json, provenance_json FROM media WHERE id = 'media-000001';
```

## Use the CLI

The repository also ships a CLI for offline resolution against the committed JSON indexes (no network needed).

Requirements: Node.js 22+, pnpm 10+.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Resolve a title/alias or an external provider ID from the local indexes:

```bash
pnpm cli -- resolve alias "Sousou no Frieren"
pnpm cli -- resolve provider bangumi subject 443666
```

Both return the matching `media-*` ID plus normalized metadata and provenance when a record is found. Add `--compact` for single-line JSON output.

| Command | Purpose |
| --- | --- |
| `resolve alias <title>` | Normalize an alias and look up its media identity |
| `resolve provider <provider> <entity> <id>` | Map an external provider ID to a media identity |
| `bangumi plan-archive <file>` | Plan a bulk import from a Bangumi archive dump |
| `contributions plan-approved` | Preview mutations from approved contribution Issues |
| `contributions apply-approved --write` | Apply approved contributions to `db/` |

## What's in the database

The committed snapshot is a seed dataset that consolidates IDs across providers and carries normalized metadata with field-level provenance (which provider, which source field, and which rule produced each value). It grows through reviewed community contributions. See `generated/stats/summary.json` for current record counts (media, aliases, provider refs, search tokens).

## Data Model

```text
reviewed source inputs
        |
        v
source/  ->  db/  ->  generated/  ->  SQLite release
                  ^
           normalized records
```

| Directory | Purpose | Edit policy |
| --- | --- | --- |
| `source/` | Approved community contributions, import manifests, and durable editorial decisions | Created through reviewed workflows |
| `raw/` | Optional captured provider evidence | Machine-written only |
| `db/` | Normalized media, alias, metadata, relation, and provenance records | Generated by the import pipeline |
| `generated/` | Deterministic lookup indexes, manifests, and statistics | Run `pnpm generate`; never edit manually |
| `apps/` | CLI, GitHub Action helper, and static viewer | Application entry points |
| `packages/` | Schemas, provider contracts, importer, validator, and generator | Reusable domain logic |

`generated/` is disposable output. `source/` and provider evidence explain how the published snapshot was produced; `db/` is the stable JSON consumption layer.

## Contribute Data

Do not edit database JSON directly. Submit an identity, alias, provider reference, or metadata correction through the [data contribution Issue form](https://github.com/ModerRAS/AnimeAtlas/issues/new/choose).

1. A maintainer reviews the structured Issue and applies the `approved` label.
2. GitHub Actions parses the contribution, applies it through the importer, regenerates indexes, and runs `pnpm check`.
3. On success, automation commits the updated `source/`, `db/`, and `generated/` records to `master`, closes the Issue, and refreshes the `download` SQLite release.

The approval label is the write gate. Community input is stored as an auditable contribution record before it affects normalized data.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm check` | Build, typecheck, validate data, verify generated artifacts, and run smoke checks |
| `pnpm validate` | Validate source and normalized records |
| `pnpm generate` | Rebuild deterministic indexes and manifests from `db/` |
| `pnpm check:generated` | Fail when committed generated artifacts are stale |
| `pnpm cli -- contributions plan-approved` | Preview approved contribution mutations without writing files |
| `pnpm cli -- contributions apply-approved --write` | Apply approved contributions locally |
| `pnpm release:sqlite` | Build `release/animeatlas.sqlite` |

Run `pnpm check` before committing a data or schema change. It is the same validation gate used by repository automation.

## Architecture

- [Architecture overview](docs/architecture.md)
- [Repository boundaries](docs/repository-architecture.md)
- [Schema-first design](docs/schema-first-architecture.md)
- [Validation and index generation](docs/validation-and-index-generation.md)
- [GitHub automation](.github/README.md)

## License

[MIT](LICENSE)
