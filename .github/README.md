# GitHub Automation

Workflows should orchestrate shared workspace scripts. Business logic belongs in `packages/` or `apps/`, not inline YAML.

Current workflows:
- `workflows/validate.yml`: runs the local validation suite on pull requests, `main`/`master` pushes, and manual dispatch. This uses `pnpm check`, including typecheck, validation, generated artifact checks, and committed smoke checks.
- `workflows/approved-issue-update.yml`: when an issue receives the `approved` label, parses the Issue Form, writes a stable contribution record, applies approved contributions, regenerates derived artifacts, validates the result, and opens a pull request.
- `workflows/release.yml`: on `main`/`master` data/code pushes, tags, or manual dispatch, regenerates and validates data, builds `release/animeatlas.sqlite`, and publishes it as the GitHub Release asset.

The approved-issue workflow does not push directly to `main`. It creates an `automation/approved-issue-<number>` branch and PR after running the same workspace commands used locally. The generated PR body contains `Closes #<issue>` so the issue closes only after the PR is merged. When that PR is merged, the push to `main`/`master` triggers the SQLite release workflow.
