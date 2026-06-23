# Stage 1: Build (on the -dev variant — keeps apt + shell + corepack so we
# can install/compile in the usual pnpm flow). DHI ships ca-certificates
# in both variants by default, so no apt-get for certs is needed.
FROM dhi.io/node:24.16.0-0-debian13-dev AS builder
WORKDIR /app

# Enable pnpm. Pin matches the root package.json `packageManager` field and
# the agent image — repo-wide pnpm@11.3.0 keeps dev / build / runtime in
# lockstep so a pnpm major shift never silently changes lockfile behavior.
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
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/

# Install dependencies (including dev dependencies for build)
# --filter . includes root devDeps (rolldown, typescript) needed by scripts/build-ts.mjs
RUN pnpm install --frozen-lockfile --filter @kici-dev/orchestrator... --filter .

# Copy build scripts and source code
COPY scripts/build-ts.mjs scripts/build-service.mjs scripts/
COPY packages/core/ packages/core/
COPY packages/shared/ packages/shared/
COPY packages/engine/ packages/engine/
COPY packages/orchestrator/ packages/orchestrator/

# Build-time git commit (passed via --build-arg since git is unavailable in builder stage)
ARG KICI_BUILD_COMMIT=unknown

# Build packages
RUN pnpm -C packages/core build && pnpm -C packages/shared build && pnpm -C packages/engine build && KICI_BUILD_COMMIT=${KICI_BUILD_COMMIT} pnpm -C packages/orchestrator build

# Re-install production-only deps so the runtime stage's copy carries no
# devDependencies. `pnpm prune --prod` does NOT recurse across workspace
# packages — a recursive `pnpm install --prod` is the canonical way to
# get a runtime node_modules tree. `--config.confirm-modules-purge=false`
# bypasses pnpm 11+'s interactive confirmation when re-install prunes
# the existing tree (no TTY during `podman build`).
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --config.confirm-modules-purge=false \
      --filter @kici-dev/orchestrator...

# nft extractor: install nftables on the -dev variant so we can COPY the nft
# binary + its shared-library closure into the distroless runtime. The runtime
# stays distroless (no apt/shell/perl); nft is the only host tool it needs
# (agent network isolation, requires --cap-add=NET_ADMIN at runtime).
FROM dhi.io/node:24.16.0-0-debian13-dev AS nft
RUN apt-get update \
  && apt-get install -y --no-install-recommends nftables \
  && rm -rf /var/lib/apt/lists/*
# Assemble the nft binary + its shared-library closure into a staging rootfs,
# preserving each file's absolute path. `ldd` resolves the closure to the
# architecture-correct multiarch triplet (x86_64-linux-gnu on amd64,
# aarch64-linux-gnu on arm64) because this stage runs on the target platform,
# so the single COPY below lands every lib at the right path on every arch —
# no hardcoded triplet, and the list self-maintains if nft's deps change.
# libc.so.6 + the dynamic loader are excluded: they already ship with the Node
# runtime base. cp -L dereferences the SONAME symlinks to copy the real files.
RUN set -eux; \
    mkdir -p /nft-rootfs/usr/sbin; \
    cp /usr/sbin/nft /nft-rootfs/usr/sbin/nft; \
    ldd /usr/sbin/nft \
      | awk '/=> \//{print $3}' \
      | grep -vE '/(libc|libm|libpthread|libdl)\.so' \
      | sort -u \
      | while IFS= read -r lib; do \
          [ -e "$lib" ] || continue; \
          mkdir -p "/nft-rootfs$(dirname "$lib")"; \
          cp -L "$lib" "/nft-rootfs$lib"; \
        done

# Stage 3: Runtime (distroless -debian13 — no apt, no shell, no perl). The nft
# binary + its shared-library closure are COPYed from the nft extractor stage;
# libc + the dynamic loader already ship with the Node base.
FROM dhi.io/node:24.16.0-0-debian13
WORKDIR /app

# nft binary + its shared-library closure, staged at arch-correct absolute
# paths in the extractor stage (see /nft-rootfs assembly above). One COPY
# replays that tree into the runtime; libc.so.6 and ld-linux are part of the
# Node base and were excluded from the staging rootfs.
COPY --from=nft /nft-rootfs/ /

# Copy the pruned workspace (prod node_modules + dist artifacts) from the builder.
COPY --from=builder --chown=node:node /app /app

# Run as non-root user
USER node

# Expose HTTP port (default orchestrator port)
EXPOSE 4000

# Use node directly (not npm) for proper SIGTERM handling
# Default: Platform-connected mode (server.js)
# Override CMD for independent mode: ["node", "packages/orchestrator/dist/standalone.js"]
CMD ["node", "packages/orchestrator/dist/server.js"]
