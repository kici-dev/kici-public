# KiCI quickstart examples

Two paths to a running KiCI orchestrator + agent on your machine. Pick whichever fits your environment.

## `compose/` — Docker / Podman

Drop-in `docker compose up -d` stack: orchestrator, agent, and PostgreSQL in three containers. Best for laptops, home servers, and quick evaluation VMs.

The compose file is **generated on every release** by `packages/ci/src/generate-quickstart-compose.ts`, so the image tags always match the latest published `quay.io/kici-dev/kici-{orchestrator,agent}` build. Don't hand-edit `compose/docker-compose.yaml` — your changes will be overwritten the next time `pnpm release` runs.

Walkthrough: [`docs/user/quickstart.md`](../../docs/user/quickstart.md).

## `bare-metal/` — native systemd install

For hosts that already run `psql` and don't want a container runtime. Uses `kici-admin orchestrator install --wizard` and `kici-admin agent install --wizard` to register systemd services. The `.env.example` here lists the env vars the wizards write into the generated `EnvironmentFile=`.

Walkthrough: [`docs/user/quickstart.md`](../../docs/user/quickstart.md) (bare-metal section).
