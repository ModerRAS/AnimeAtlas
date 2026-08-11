# AnimeAtlas v2 Catalog

AnimeAtlas v2 separates names, installments, episode identity, and numbering.

```text
series -> media (Season/Part/Cour) -> episode -> episode_numbers
```

A `media` record is the provider-subject-level installment. It owns the curated
Season context. An `episode` references exactly one media record, so every
number attached to that episode is constrained to the same Season.

## Records

- `db/series/`: provider-independent title lineage.
- `db/series-aliases/`: base names that may expand to multiple media candidates.
- `db/media/`: concrete installments and provider subject references.
- `db/aliases/`: installment-specific aliases.
- `db/episodes/`: stable episode IDs, provider episode refs, and namespaced numbers.
- `db/metadata/`: normalized display metadata and field provenance.

Legacy v1 media remain valid during migration. Unknown Season values are not
invented. A media becomes v2 only after its `series_id` and installment context
are verified. Curated batches are recorded in `db/migrations/v2-*.json`;
`pnpm migrate:v2` validates cached Bangumi subject/title evidence before
`--write` can update catalog records. Unknown installment context remains an
empty object instead of a guessed Season. Provider exceptions, including a
current API 404 and title-verified Bangumi type 6 records, are isolated in a
separate evidence plan.

## Episode Numbers

Episode identity is independent of numbering. The same episode may carry:

- `bangumi:ep`
- `bangumi:sort`
- `media:local`
- `series:absolute`
- `release:observed`

Provider values are preserved verbatim. AnimeAtlas does not force a global
number such as `78` into an `S04E06` representation.

## Resolution

Aliases map to candidate sets. A series alias expands to every media in the
series, while a media alias points directly to an installment. Season, Part,
and Cour context filter candidates. The resolver returns exactly one of:

- `resolved`
- `ambiguous`
- `unresolved`

The legacy exact index contains only aliases with one candidate. The v2 index
is `generated/indexes/aliases/candidates.json`.

## Contributions

Contributors use natural Issue fields: the name that should resolve, the correct
Bangumi subject, optional Season/Part context, and optional episode mapping.
Accepted episode text includes `06(78)`, `ep=6 sort=78`, and natural local/global
wording.

Automation performs these checks before producing `contribution/v2`:

1. Resolve the Bangumi subject to a v2 media.
2. Compare submitted and filename-derived installment context with stored media.
3. Parse user episode numbers.
4. Match all numbers to one episode inside the selected media.
5. Emit atomic alias and episode-number changes.

A Season mismatch, cross-media episode, unresolved pair, or ambiguous pair
blocks the contribution. Human Issue fields are not the strict schema boundary;
the generated contribution is.

## AniFileBERT

The release metadata pins `ModerRAS/AniFileBERT` and its exact revision.
AniFileBERT supplies filename/path title and Season observations. The initial
v2 contract does not require the model to extract multiple episode numbers;
the Issue field supplies those values and automation normalizes them.

## Versioning

SQLite `release_info` records the catalog, contribution, normalization,
generator, and parser versions. Releases publish:

- a stable `download/animeatlas.sqlite` alias;
- an immutable `animeatlas-<version>.sqlite` artifact;
- SHA-256 manifests for both names.

## Library Replay

`pnpm replay:library` opens `S:/动漫/library.db`, immediately enables
`PRAGMA query_only=ON`, and reads only paths already stored in `media_file`.
It never traverses the media filesystem. The report is written outside the
catalog source tree under `reports/`. `season_conflicts` counts rows where no
catalog candidate agrees with the stored MLIP Season observation. A unique
catalog candidate remains visible in the report with `season_conflict: true`;
multiple candidates are never resolved across that conflict.
