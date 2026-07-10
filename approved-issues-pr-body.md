Applies all currently open AnimeAtlas issues with the approved label.

This PR is updated by the approved issue workflow after running:
- `pnpm build`
- `pnpm --filter @animeatlas/github-action start -- sync-approved-issues`
- `pnpm cli -- contributions apply-approved --write`
- `pnpm generate`
- `pnpm check`

Included issues:
- Closes #72
