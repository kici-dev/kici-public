# Quickstart compose stack

Two files are **generated** on every release by `packages/ci/src/generate-quickstart-compose.ts`:

- `docker-compose.yaml` — two-service stack (postgres + orchestrator). Pins the `postgres` image from `containers.lock.yaml` (the same pin every other compose in this repo follows) and the `kici-orchestrator` image at the just-released version on `quay.io/kici-dev/`. The orchestrator has the container runtime socket bind-mounted and reads `scalers.yaml` at startup.
- `scalers.yaml` — container-scaler configuration. Names the `kici-agent` image at the same just-released version. The orchestrator spawns one agent container per job, then tears it down.

Don't hand-edit either file. To change the templates, edit `buildQuickstartCompose()` / `buildQuickstartScalers()` in the generator.

## Download + run

```bash
mkdir my-kici && cd my-kici
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/docker-compose.yaml
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/scalers.yaml
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/.env.example
cp .env.example .env
# Fill in the three values, then:
docker compose up -d
docker compose logs -f orchestrator
```

Full walkthrough: [`docs/user/quickstart.md`](../../../docs/user/quickstart.md).
