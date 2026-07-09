# Bangumi Raw Cache

Bangumi has two independent machine-managed raw-cache modes:

- `archive/`: payloads from `https://github.com/bangumi/Archive`, used for initialization, rebuilds, and large backfills.
- `api/`: payloads from `https://github.com/bangumi/api`, used for incremental synchronization.

Both modes must feed the same Bangumi normalizer and importer contracts.
