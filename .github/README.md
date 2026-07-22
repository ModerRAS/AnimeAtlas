# GitHub Automation

Workflows should orchestrate shared workspace scripts. Business logic belongs in `packages/` or `apps/`, not inline YAML.

Current workflows:
- `workflows/validate.yml`: runs the local validation suite on pull requests, `main`/`master` pushes, and manual dispatch. This uses `pnpm check`, including typecheck, validation, generated artifact checks, and committed smoke checks.
- `workflows/approved-issue-update.yml`: when an issue receives the `approved` label, serializes approved-issue processing, syncs all open approved Issue Forms into stable contribution records, applies approved contributions, regenerates derived artifacts, validates the result, commits the controlled data paths directly to `master`, closes the applied issues, and starts the release workflow.
- `workflows/release.yml`: on `main`/`master` data/code pushes, tags, or manual dispatch, regenerates and validates data, builds `release/animeatlas.sqlite`, and publishes it as the GitHub Release asset.

The approved-issue workflow commits only `source/contributions/approved`, `db`, and `generated` to `master` after running the same workspace commands used locally. The workflow uses one global concurrency group so approved issue updates do not run against `db/` and `generated/` concurrently. Each run re-syncs all open approved issues, so a later run can apply a batch even when several approved labels arrive close together. It closes the applied issues only after the commit is pushed, then explicitly dispatches the SQLite release workflow because commits made with `GITHUB_TOKEN` do not trigger push workflows.
