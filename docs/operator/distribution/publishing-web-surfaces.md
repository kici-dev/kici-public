---
title: Publishing web surfaces
description: How KiCI ships its three public web surfaces, including the independent docs and marketing publish flow that runs between releases.
---

KiCI serves three public web surfaces from a content-delivery network (CDN):
the dashboard app (`app.kici.dev`), the marketing apex (`kici.dev` /
`www.kici.dev`), and the documentation site (`docs.kici.dev`). Each surface is
uploaded as an immutable, content-addressed bundle, and a single edge pointer
selects which bundle is live. Moving a pointer is an atomic, instant cutover —
no cache purge, no rebuild of the other surfaces.

## The three surfaces and their cadences

The surfaces do not share a single pointer. Each has its own live-version
pointer and its own publishing cadence:

| Surface         | Hostname                    | Published by                                     | Cadence                         |
| --------------- | --------------------------- | ------------------------------------------------ | ------------------------------- |
| App (dashboard) | `app.kici.dev`              | A production release                             | Release-coupled                 |
| Marketing       | `kici.dev` / `www.kici.dev` | `pnpm publish:marketing`                         | Independent only                |
| Docs            | `docs.kici.dev`             | A production release **and** `pnpm publish:docs` | Release-coupled and independent |

- **App and marketing splash** ship together with a production release. The app
  bundle is rebuilt at the release commit and goes live as part of that release.
- **Docs** ship with every production release (docs describe current product
  behavior, so a release rebuilds and republishes them at the release commit),
  **and** can be published independently between releases. A docs-only fix —
  fixing a typo, clarifying a procedure — does not need a full release to go live.
- **The marketing apex** is published **only** independently, never as part of a
  release. Landing, pricing, and legal copy are timed by marketing decisions,
  not by code releases, so a committed-but-not-yet-intended marketing edit can
  never auto-go-live on an unrelated release.

### Why docs and marketing differ

Docs follow the code: they describe what the product does now, so the docs
pointer only ever moves forward and a release never regresses an
independently-published docs fix. Marketing is independently timed: a release
never touches the marketing pointer, so unrelated copy edits stay parked until
you publish them on purpose.

## Publishing docs or marketing independently

`pnpm publish:docs` and `pnpm publish:marketing` publish a single surface
between releases. Both enforce a staging-first rollout: the change is deployed
and verified on staging before it ever reaches production. Each command:

1. **Refuses a dirty working tree.** Publishes are from a committed tree only —
   the published bundle must correspond to an exact commit.
2. **Computes a content-addressed prefix** of the form `<surface>-<gitsha>`
   (for example `docs-1b35958`) from the current commit.
3. **Builds the surface** (the docs build uses the public docs flavor).
4. **Deploys to staging and verifies it** before touching production.
5. **Uploads the immutable `<surface>-<gitsha>` bundle** to CDN storage. The
   prefix is content-addressed and never overwritten.
6. **Flips the live pointer** for that surface to the new prefix, then runs a
   content-only CDN apply (see below) so the edge serves the new bundle.
7. **Verifies production** — robots, sitemap, and key pages return `200`.
8. **Auto-commits** the pointer change so the live version is recorded in git.
9. **Garbage-collects old prefixes**, keeping the last five bundles per surface
   plus the live one and deleting anything older.

Because each surface has its own pointer, a docs publish never touches the app,
marketing, or the rest of a release — only the docs edge rewrite changes.

### The pointer flip is a content-only CDN apply

Moving a pointer is a content-only CDN change, applied with a plan-then-confirm
step: the apply shows you the single pointer-value change before it runs, and
you confirm it explicitly. This is deliberately distinct from a full production
release — no images are republished, no packages are version-bumped, and the
other surfaces are untouched. The public URL itself does not change; only which
stored bundle the edge serves behind that URL changes.

## Reading the live versions

`pnpm publish:status` prints the live bundle prefix for each surface, read from
the committed pointer values. Use it to confirm what is currently serving on
`app.kici.dev`, `kici.dev`, and `docs.kici.dev` before or after a publish.

## Rolling back

`pnpm publish:docs --rollback [<sha>]` repoints the docs surface to a prior
bundle. Because every `<surface>-<gitsha>` bundle is immutable and recent
bundles are retained, a rollback is an instant repoint to a previously-published
prefix — it never rebuilds and never overwrites a bundle. Pass an explicit
`<sha>` to target a specific prior bundle, or omit it to repoint to the
previous committed prefix. The marketing surface rolls back the same way via
`pnpm publish:marketing --rollback [<sha>]`.

## See also

- [Release artifacts and digests](./release-artifacts.md) — the digest-pinned
  container images and npm packages cut by a production release.
- [Distribution overview](./distribution.md) — how KiCI packages and ships its
  releasable artifacts.
