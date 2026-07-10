# GitHub Automation

Workflows should orchestrate shared workspace scripts. Business logic belongs in `packages/` or `apps/`, not inline YAML.

Current workflows:
- `workflows/validate.yml`: runs the local validation suite on pull requests, `main`/`master` pushes, and manual dispatch. This uses `pnpm check`, including typecheck, validation, generated artifact checks, and committed smoke checks.
- `workflows/approved-issue-update.yml`: when an issue receives the `approved` label, serializes approved-issue processing, syncs all open approved Issue Forms into stable contribution records, applies approved contributions, regenerates derived artifacts, validates the result, and creates or updates one aggregate pull request.
- `workflows/release.yml`: on `main`/`master` data/code pushes, tags, or manual dispatch, regenerates and validates data, builds `release/animeatlas.sqlite`, and publishes it as the GitHub Release asset.

The approved-issue workflow does not push directly to `main`. It updates the single `automation/approved-issues` branch and PR after running the same workspace commands used locally. The workflow uses one global concurrency group so approved issue updates do not run against `db/` and `generated/` concurrently. Each run re-syncs all open approved issues, so a later run can fill the aggregate PR even when several approved labels arrive close together. The generated PR body contains `Closes #<issue>` lines so issues close only after the PR is merged. When that PR is merged, the push to `main`/`master` triggers the SQLite release workflow.
