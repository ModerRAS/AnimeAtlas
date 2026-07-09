# AnimeAtlas

Open Anime Identity & Metadata Database for offline scraping.

Given an anime title, alias, or external provider ID, AnimeAtlas should resolve a stable internal media identity and return unified metadata without repeated online API requests. Alias handling is one feature of that database, not the product boundary.

Current design direction:
- TypeScript on modern Node.js LTS
- pnpm workspace monorepo
- provider-first architecture
- deterministic builds and generated indexes
- GitHub Issue based community contributions
- long-term auditability and reproducibility

Primary design documents:
- [Architecture](docs/architecture.md)
- [Repository Architecture](docs/repository-architecture.md)
- [Schema-First Architecture](docs/schema-first-architecture.md)
- [Validation and Index Generation Design](docs/validation-and-index-generation.md)

Current implementation tranche:
- `packages/core` contains provider-neutral identity, normalization, hashing, and stable JSON helpers.
- `packages/schema` contains tranche-1 JSON Schemas.
- `packages/providers` defines provider capabilities and normalized provider candidate contracts.
- `packages/provider-bangumi` implements the first provider boundary with Bangumi Archive JSON/JSONL reading, Archive bulk import, and Bangumi API incremental-update factories.
- `packages/importer` reads existing media identities, plans provider-neutral imports, dry-runs approved contribution mutations, and applies them only through explicit write mode.
- `apps/github-action` parses approved GitHub Issue forms, writes stable approved contribution records, and powers the approved-issue PR workflow.
- `apps/viewer` builds a static offline inspection UI from committed `db/` and `generated/` JSON.
- `packages/validator` validates provider manifests and the split `db/` records.
- `packages/generator` builds reproducible `generated/` indexes and manifests.

Useful commands:
Resolver output includes the matched `media-*` ID, normalized metadata, and provenance sidecar.

- `pnpm install`
- `pnpm validate`
- `pnpm generate`
- `pnpm check:generated`
- `pnpm cli -- resolve alias "Sousou no Frieren"`
- `pnpm cli -- resolve provider bangumi subject 443666`
- `pnpm cli -- bangumi plan-archive <archive.jsonl> --format jsonl --last-sync 2026-07-08T12:34:56Z`
- `pnpm --filter @animeatlas/github-action start -- write-approved-contribution <github-event-path>`
- `pnpm cli -- contributions plan-approved`
- `pnpm cli -- contributions apply-approved`
- `pnpm cli -- contributions apply-approved --write`
- `pnpm viewer`
- `pnpm release:sqlite`
- `pnpm smoke`
- `pnpm check`
