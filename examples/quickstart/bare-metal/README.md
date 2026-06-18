# Bare-metal quickstart assets

This directory holds the assets consumed by the [bare-metal quickstart](../../../docs/user/quickstart/bare-metal.md). The walkthrough downloads them via `curl` and walks you through filling in the placeholder values.

- `.env.example` — orchestrator env file template; fill in the three placeholder values. The database URL is prefilled with the loopback-only stub password `kici-local`. Also carries the `KICI_STORAGE_*` block wired to the bundled SeaweedFS store so `kici run remote` works out of the box.
- `docker-compose.postgres.yaml` — compose that runs the two backing services on loopback (step 3, Option A): PostgreSQL 18 on `127.0.0.1:5432` and a SeaweedFS object store on `127.0.0.1:8333`. The orchestrator itself still runs natively; only the database and cache store are containerised. The DB password defaults to the loopback-only stub `kici-local`; override it by exporting `POSTGRES_PASSWORD` or setting it in a sibling `.env`.
- `seaweedfs-s3.json` — static S3 identity for the SeaweedFS store; mounted by the compose above. Download it next to `docker-compose.postgres.yaml`.
- `scalers.dual.yaml` — optional dual-scaler config that runs both a `container` scaler and a `bare-metal` scaler on one host (see "run both scaler types" in the quickstart).

Unlike `examples/quickstart/compose/`, the assets here are **not** regenerated on every release — the bare-metal flow installs `kici-admin@latest` from npm, so there's no version-pinned artefact to keep in sync. Edit these files directly when the orchestrator's env-var or scaler-config contract changes.
