# Source Data

Durable human-reviewed inputs live here: approved contribution records, resolution decisions, and provider import manifests.

Contributors should enter changes through GitHub Issues; automation turns approved issues into records under `source/contributions/approved/`. Those records are source inputs only. Use `pnpm cli -- contributions plan-approved` or `pnpm cli -- contributions apply-approved` to preview normalized `db/` mutations. Only `pnpm cli -- contributions apply-approved --write` applies them, and generated artifacts still need regeneration afterward.
