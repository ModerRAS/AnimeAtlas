# AnimeAtlas

[![Validate](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml/badge.svg)](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml)
[![Download SQLite](https://img.shields.io/badge/download-animeatlas.sqlite-00897B)](https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite)

[中文](README.md) | [English](README.en.md)

An open anime identity and metadata database for offline lookup.

AnimeAtlas resolves anime names and external provider IDs to a stable `series -> media -> episode` identity chain. Media records carry verified Season/Part context, while episode numbers retain provider namespaces such as `bangumi:ep` and `bangumi:sort`.

## Download the database

A single-file SQLite snapshot is published under a **fixed download link** that always points at the latest build — the URL never changes between releases:

```
https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

```bash
curl -L -o animeatlas.sqlite \
  https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

The `download` release remains a stable alias. Every publish also creates an immutable semantic-version release with `animeatlas-<version>.sqlite` and a SHA-256 manifest. Exact catalog, SQLite schema, generator, normalization, and parser revisions are embedded in `release_info`:

```sql
SELECT key, value FROM release_info ORDER BY key;
```

### SQLite schema

```text
series                 (id, title, relationships_json)
media                  (id, series_id, season_number, part_number, cour_number, metadata_json, provenance_json)
series_aliases         (series_id, value, normalized, language, type, source, confidence)
aliases                (media_id, value, normalized, language, type, source, confidence)
provider_refs          (media_id, provider, entity, provider_id, provider_key)
episodes               (id, media_id, kind, provenance_json)
episode_provider_refs  (episode_id, provider, entity, provider_id)
episode_numbers        (episode_id, namespace, number_value, source)
search_tokens           (token, media_id)
release_info            (key, value)
```

Aliases form candidate sets; duplicate normalized aliases across installments are valid. `aliases_v1_compat` exposes only aliases that resolve to one media. Episodes belong to one media, which guarantees that namespaced numbers cannot silently cross Seasons.

### Query examples

```sql
-- Resolve an alias. `normalized` stores NFKC + trimmed + lowercased text.
SELECT m.id, m.title
FROM aliases a JOIN media m ON m.id = a.media_id
WHERE a.normalized = 'sousou no frieren';

-- Look up a media identity by a Bangumi subject ID.
SELECT m.id, m.title, m.summary
FROM provider_refs p JOIN media m ON m.id = p.media_id
WHERE p.provider = 'bangumi' AND p.entity = 'subject' AND p.provider_id = '400602';

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
pnpm cli -- resolve alias "Tensei Shitara Slime Datta Ken" --season 4
pnpm cli -- resolve provider bangumi subject 515594
```

Both return a typed `resolved`, `ambiguous`, or `unresolved` result. Alias resolution reads the candidate-set index and accepts `--season`, `--part`, and `--cour`. Add `--compact` for single-line JSON output.

| Command | Purpose |
| --- | --- |
| `resolve alias <title> [--season N]` | Resolve a candidate set with installment context |
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

Do not edit database JSON directly. Use the recognition or Season/episode Issue form. Contributors enter natural observations and a Bangumi target; automation validates Season ownership and converts optional text such as `06(78)` into typed episode-number changes before approval.

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
| `pnpm release:sqlite` | Build stable and immutable SQLite artifacts plus SHA-256 manifests |
| `pnpm migrate:v2` | Audit all curated `db/migrations/v2-*.json` plans; add `-- --refresh` for live evidence or `-- --write` to apply cached evidence |
| `pnpm audit:v2` | Cache and classify any remaining v1 Bangumi subjects, relations, and paginated regular episodes |
| `pnpm replay:library` | Compare v1/v2 against paths stored in read-only `library.db` |

Run `pnpm check` before committing a data or schema change. It is the same validation gate used by repository automation.

## Architecture

- [AnimeAtlas v2 catalog](docs/v2-catalog.md)
- [Architecture overview](docs/architecture.md)
- [Repository boundaries](docs/repository-architecture.md)
- [Schema-first design](docs/schema-first-architecture.md)
- [Validation and index generation](docs/validation-and-index-generation.md)
- [GitHub automation](.github/README.md)

## License

[MIT](LICENSE)
