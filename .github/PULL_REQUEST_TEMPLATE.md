<!--
Thanks for contributing to KiCI! A few things worth knowing before you
open this PR (see CONTRIBUTING.md for the full story):

- This repo is a projection of a private upstream monorepo. An accepted
  PR is replayed upstream by a maintainer, released, and the next sync
  overwrites `main` here — your PR is then closed referencing the
  upstream commit. The back-port IS the merge; don't expect a direct
  merge on `main` here.
- Review is asynchronous — usually a few days, not minutes.
-->

## What & why

<!-- One paragraph: what does this change, and why? Link any issue it
closes with `Closes #123`. -->

## How it was tested

<!-- Commands you ran, new/updated tests, manual verification. -->

## Checklist

- [ ] Title is a [Conventional Commit](https://www.conventionalcommits.org/) (e.g. `fix(orchestrator): clamp retry backoff`)
- [ ] One concern per PR — no unrelated refactor/feature/style mixed in
- [ ] Tests added or updated for the changed logic
- [ ] No formatting-only churn (Prettier runs upstream via lint-staged)
- [ ] Docs updated if behaviour changed
