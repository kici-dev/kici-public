# Contributing to KiCI

Thanks for thinking about contributing. This page covers the practical
flow for issues and PRs against this public mirror.

## Where development actually happens

The day-to-day source-of-truth lives in a **private upstream monorepo**.
This repo (`kici-dev/kici-public`) is a projection of KiCI's open-source
packages, produced by an internal sync at each release.

Practical consequence: when a PR is accepted on this repo, a maintainer
replays the change upstream, runs the full test matrix, releases, and the
next sync overwrites this repo's `main` with the new projection. The
original PR is closed referencing the upstream commit. Don't expect your PR
to merge directly on `main` here — the back-port is the merge.

This trade-off is deliberate: it keeps the public OSS surface honest while
development happens in one place. The downside is that the review cycle is
asynchronous — you'll usually hear back within a few days, not minutes.

## Issues

Bug reports and feature requests are welcome on the public issue
tracker at <https://github.com/kici-dev/kici-public/issues>. Include:

- KiCI version (`kici --version`).
- Node version, package manager, OS.
- A minimal reproduction (a tiny workflow file + the command you ran).
- The actual vs expected behavior, with logs if any.

For questions that aren't bug reports, prefer Discussions over Issues —
the Issue tracker is for actionable defects and concrete feature
proposals.

## Security reports

**Do not report security issues in public Issues.** See
[`SECURITY.md`](SECURITY.md) for the disclosure process (or email
`security@kici.dev` if `SECURITY.md` isn't published yet — it's
forthcoming).

## Pull requests

PRs are accepted against `main`. The review checklist:

- **Conventional Commit** title (e.g. `fix(orchestrator): clamp …`,
  `docs(user): clarify …`). Body explains the "why" more than the
  "what".
- **One concern per PR.** Refactor + feature + style cleanup in the
  same diff makes the back-port hard to verify; a maintainer will
  usually ask you to split.
- **Tests.** Any logic change needs a test that exercises it. The
  exact test framework depends on the package; copy the pattern of
  the neighboring `*.test.ts` files.
- **No formatting churn.** Prettier runs on every save in the
  upstream repo via lint-staged; an unrelated reformat that touches
  hundreds of lines drowns the review signal.

When you open a PR, a maintainer will tag it and start the back-port.
Iteration happens in the PR thread; once the upstream change lands and
ships in a release, this repo's `main` updates and the PR gets closed
with a reference to the upstream commit.

## Setting up to build locally

```bash
git clone https://github.com/kici-dev/kici-public.git
cd kici-public
pnpm install
pnpm -r run build
pnpm -r run test
```

Requires Node 24 (pinned via `mise.toml` if you use mise) and pnpm 10+.
The quickstart at [`docs/user/quickstart.md`](docs/user/quickstart.md)
covers the end-to-end "author a workflow, run it locally, optionally
connect a hosted orchestrator" loop.

## License

By contributing, you agree your contribution is licensed under the same
terms as the file you're editing — Apache-2.0 for the SDK / compiler /
shared / kici packages, AGPL-3.0-only for the engine / orchestrator /
agent / kici-admin packages. See [`LICENSES.md`](LICENSES.md) for the
per-package matrix and the per-package `LICENSE` file alongside each
package for the full text.
