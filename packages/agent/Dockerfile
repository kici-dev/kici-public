# Stage 1: Build (on the -dev variant — keeps apt + shell + corepack so we
# can install/compile/rebuild oxc-transform in the usual pnpm flow). DHI
# ships ca-certificates by default, so no apt-get for certs is needed.
FROM dhi.io/node:24.16.0-0-debian13-dev AS builder
WORKDIR /app

# Enable pnpm. Pin 11.3.0 to match the runtime stage (see below): the same
# pnpm builds our bundle and installs customer .kici/ deps.
# The DHI node:24.16.0-0-debian13-dev base ships a bundled corepack whose
# extracted shims under /usr/lib/nodejs/corepack/dist/*.js land without the
# executable bit, so the /usr/bin/pnpm symlink fails with exit 126
# ("Permission denied") when invoked directly. Restore +x after activation.
# Retry corepack prepare: the pnpm tarball download (fetchUrlStream) can fail on
# a transient registry hiccup, which would otherwise fail the whole image build.
RUN corepack enable \
  && { n=0; until corepack prepare pnpm@11.3.0 --activate; do \
         n=$((n+1)); [ "$n" -ge 5 ] && { echo "corepack prepare pnpm failed after $n attempts" >&2; exit 1; }; \
         echo "corepack prepare pnpm failed (attempt $n), retrying in 5s..." >&2; sleep 5; \
       done; } \
  && chmod a+x /usr/lib/nodejs/corepack/dist/*.js

# Copy workspace configuration and root package files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

# Throttle pnpm's network concurrency for the in-container installs below. The
# build resolves dependencies from npmjs through the host's resolver; pnpm's
# supply-chain verification + tarball download otherwise bursts the default 16
# concurrent requests, which overwhelms a stub resolver under load (EAI_AGAIN)
# and wedges the build. A modest concurrency keeps every fetch reliable; the
# extra fetch-retries absorb transient resolver hiccups. Scoped to the
# container build — the host's own .npmrc is unchanged.
RUN printf '\nnetwork-concurrency=6\nfetch-retries=6\nfetch-timeout=120000\n' >> .npmrc

# Copy package.json files for dependency resolution
# Agent depends on: @kici-dev/shared, @kici-dev/engine, @kici-dev/sdk
# (@kici-dev/shared and @kici-dev/sdk depend on @kici-dev/core)
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/

# Install dependencies (including dev dependencies for build)
# --filter . includes root devDeps (rolldown, typescript) needed by
# scripts/build-ts.mjs — still used at build time to compile .ts sources in
# shared/engine/sdk/agent into dist/, even though runtime uses the oxc-transform
# loader hook and no longer bundles workflows.
RUN pnpm install --frozen-lockfile --filter @kici-dev/agent... --filter .

# Copy build scripts and source code for all four packages
COPY scripts/build-ts.mjs scripts/build-service.mjs scripts/
COPY packages/core/ packages/core/
COPY packages/shared/ packages/shared/
COPY packages/engine/ packages/engine/
COPY packages/sdk/ packages/sdk/
COPY packages/agent/ packages/agent/

# Build-time git commit (passed via --build-arg since git is unavailable in builder stage)
ARG KICI_BUILD_COMMIT=unknown

# Build packages in dependency order
RUN pnpm -C packages/core build && \
    pnpm -C packages/shared build && \
    pnpm -C packages/engine build && \
    pnpm -C packages/sdk build && \
    KICI_BUILD_COMMIT=${KICI_BUILD_COMMIT} pnpm -C packages/agent build

# Re-install production-only deps so the runtime stage's copy carries no
# devDependencies. `pnpm prune --prod` does NOT recurse across workspace
# packages — a recursive `pnpm install --prod` is the canonical path.
# `--config.confirm-modules-purge=false` bypasses pnpm 11+'s interactive
# confirmation when the install prunes the existing tree (no TTY during
# `podman build`).
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --config.confirm-modules-purge=false \
      --filter @kici-dev/agent...

# Set up oxc-transform's native N-API binding used by
# `@kici-dev/shared/ts-loader-hook`. `oxc-transform` is a direct dep of
# `@kici-dev/shared`, so rebuild it from shared's install location.
RUN cd packages/shared && pnpm rebuild oxc-transform

# Verify the ts-loader-hook resolves + its transformer is callable (must be
# pre-baked into the image). Running from packages/shared because
# `oxc-transform` is a direct dep there, not of packages/agent.
RUN cd packages/shared && node --input-type=module -e "import('oxc-transform').then(m => { if (typeof m.transformSync !== 'function') process.exit(1); })"

# Stage 2: Runtime
# Agent runtime dependencies:
# - git: repository cloning
# - bash: step execution via zx (Debian's /bin/sh is dash, so explicitly install bash)
# - curl: a network fetcher every generic-init / setup script reasonably expects
#   (e.g. `curl -fsSL https://mise.run | sh` to provision a toolchain before steps)
# - gzip + xz-utils: decompressors `tar -xz` / `tar -xJ` shell out to. The DHI
#   base ships `tar` but not the codec binaries, so a setup script that fetches
#   a `.tar.gz` / `.tar.xz` toolchain (mise's installer extracts a gzip tarball)
#   fails with `gzip: Cannot exec: No such file or directory` before any step.
# - iptables: MMDS metadata block when running as root
# - node: runtime + child process spawning (base image)
# - npm: .kici/ dependency installation for npm projects (ships with node)
# - pnpm: .kici/ dependency installation for pnpm-workspace repos (activated
#   below via corepack; >= 11.1.2 is required so a workspace with a
#   minimumReleaseAge soak does not throw ERR_PNPM_MISSING_TIME)
# - yarn: .kici/ dependency installation for yarn projects (classic + berry).
#   Classic is the baked 1.22.22 (frozen final v1, activated below via corepack;
#   it never needs a bump). Berry (v2+) is per-repo version-pinned via the repo's
#   `packageManager` field; corepack auto-fetches that version on demand at
#   install time (no baked berry version possible), so the agent needs network
#   egress when installing a berry project's deps.
# - @kici-dev/shared/ts-loader-hook: TS transform on import (uses oxc-transform,
#   a native N-API binding; pre-baked in the builder stage and copied verbatim)
# Optional host-level tools (not included, operator installs): bwrap, docker/podman.
#
# Runtime base is the -dev variant because the agent needs apt-installed
# host tools (git/bash/iptables) at runtime. ca-certificates ships with
# the DHI base, so it isn't installed here.
FROM dhi.io/node:24.16.0-0-debian13-dev
WORKDIR /app

# Install the CI userland, then strip perl ENTIRELY — including the Essential
# perl-base. The agent never invokes perl, so removing it eliminates the whole
# perl-source CVE surface (e.g. DEBIAN-CVE-2026-8376/12087/42496, which OSV
# maps to the perl SOURCE package and would otherwise surface via the retained
# perl-base on the node base image). Customer CI steps that shell out to perl
# are unsupported by design — this is a deliberate operator decision to keep the
# image perl-free rather than carry the perl CVEs.
#
# Order matters: first force-remove the non-Essential perl set
# (perl-modules-5.40 / libperl5.40 / liberror-perl and the perl metapackage),
# then purge the Essential perl-base with --force-remove-essential. Debian's
# git declares a hard `Depends: perl, liberror-perl` and debconf depends on
# perl-base, so --force-depends is required to drop them without cascade-
# removing git; --force-remove-essential is additionally required for perl-base.
# The git binary does not link libperl — only perl-subcommands (git svn /
# send-email / add -i) need it, and those are out of scope for the agent — so
# core git clone / checkout / fetch keep working after the purge.
#
# The DHI node base ships its SBOM as one stub file per package under
# /var/lib/dpkg/status.d/ (the distroless SBOM convention), which dpkg does NOT
# manage — so a dpkg purge leaves the perl SBOM stubs behind and OSV-Scanner
# still attributes the perl-source CVEs to the image. Now that the perl files
# are genuinely gone, delete the matching SBOM stubs so the image's SBOM
# reflects reality and the CVE gate sees no perl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash curl gzip xz-utils iptables \
  && dpkg --remove --force-depends perl perl-modules-5.40 libperl5.40 liberror-perl \
  && dpkg --purge --force-depends --force-remove-essential perl-base \
  && rm -f /var/lib/dpkg/status.d/perl /var/lib/dpkg/status.d/perl-base \
       /var/lib/dpkg/status.d/perl-modules-5.40 /var/lib/dpkg/status.d/libperl5.40 \
       /var/lib/dpkg/status.d/liberror-perl \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

# Activate pnpm + yarn for installing customer .kici/ deps in pnpm-workspace and
# yarn-classic repos. corepack ships with the Node base; the pnpm pin matches the
# builder stage. yarn 1.22.22 is the frozen final v1 release.
# The DHI node:24.16.0-0-debian13-dev base ships a bundled corepack whose
# extracted shims under /usr/lib/nodejs/corepack/dist/*.js land without the
# executable bit, so the /usr/bin/{pnpm,yarn} symlinks fail with exit 126
# ("Permission denied") when invoked directly. Restore +x after activation.
# Retry each corepack prepare: the tarball download (fetchUrlStream) can fail on
# a transient registry hiccup, which would otherwise fail the whole image build.
RUN corepack enable \
  && { n=0; until corepack prepare pnpm@11.3.0 --activate; do \
         n=$((n+1)); [ "$n" -ge 5 ] && { echo "corepack prepare pnpm failed after $n attempts" >&2; exit 1; }; \
         echo "corepack prepare pnpm failed (attempt $n), retrying in 5s..." >&2; sleep 5; \
       done; } \
  && { n=0; until corepack prepare yarn@1.22.22 --activate; do \
         n=$((n+1)); [ "$n" -ge 5 ] && { echo "corepack prepare yarn failed after $n attempts" >&2; exit 1; }; \
         echo "corepack prepare yarn failed (attempt $n), retrying in 5s..." >&2; sleep 5; \
       done; } \
  && chmod a+x /usr/lib/nodejs/corepack/dist/*.js

# Copy the pruned workspace (prod node_modules + pre-rebuilt oxc-transform
# native binding + dist artifacts) from the builder.
COPY --from=builder --chown=node:node /app /app

# Run as non-root user
USER node

# Expose health endpoint port (default 8080)
EXPOSE 8080

# Use node directly (not npm) for proper SIGTERM handling
CMD ["node", "packages/agent/dist/server.js"]
