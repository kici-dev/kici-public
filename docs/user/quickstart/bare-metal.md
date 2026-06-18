---
title: 'Quickstart: bare metal'
description: Install the orchestrator + agent as native services on Linux or macOS, connected to the public Platform relay
---

This guide brings up a KiCI orchestrator + agent as native services (systemd on Linux, launchd on macOS), connected to the public Platform relay. The orchestrator and its on-demand agents run as native processes — no orchestrator or agent containers. Two backing services do run in containers: PostgreSQL (the database) and a small SeaweedFS object store (which powers `kici run remote`); running PostgreSQL as a container is the least-fiddly option, so this guide treats it as the default and keeps a native PostgreSQL install as the alternative. The guide is in two parts:

- **Part 1 — your first run, no GitHub needed (~10 min):** sign up, mint a token, stand up PostgreSQL + SeaweedFS, install the orchestrator as a native service, configure the scaler, and run a workflow against your orchestrator straight from your working tree with `kici run remote`.
- **Part 2 — GitHub-triggered runs (~10 min):** register a GitHub App, wire the webhook, and push a commit so your team's commits trigger runs automatically.

For the fully container-based path (orchestrator + agents in containers too) see the [Docker / Podman quickstart](./compose.md). For the chooser overview, see [Choose your path](../quickstart.md).

You'll end up with:

- The orchestrator running as a native service (systemd on Linux, launchd on macOS), configured to spawn agent processes on demand via the bare-metal scaler.
- A PostgreSQL 18 database and a SeaweedFS object store backing the orchestrator — PostgreSQL as a container (recommended) or installed natively, SeaweedFS as a container.
- A first workflow run you trigger yourself (Part 1), and then real GitHub pushes triggering runs automatically (Part 2), with logs visible in the dashboard at `https://app.kici.dev`.

## Prerequisites

- A Linux host (systemd — Debian 13 / Ubuntu 24.04 / equivalent) or macOS (launchd). `kici-admin orchestrator install` auto-detects which; on Linux a user-level service is fine, with root not required for the basic flow.
- Node.js 24+ available on `PATH` (`node --version`). [mise](https://mise.jdx.dev/) or `nvm` works; a system package works too.
- `docker` (or `podman`) with `docker compose` (or `podman compose`) available — version 2.20+. The orchestrator and its agents run natively, but the backing PostgreSQL and the SeaweedFS object store (the latter powers `kici run remote`) run as containers. Option B in step 3 installs PostgreSQL 18 natively via `apt` (Debian/Ubuntu shipped 18.0 in 2025; for older distros use the [official PostgreSQL apt repository](https://www.postgresql.org/download/linux/debian/)) but still runs the SeaweedFS container.
- An account at [app.kici.dev](https://app.kici.dev) — you'll create one in step 1.
- About 10 minutes for Part 1.

Part 2 (GitHub-triggered runs) needs a GitHub App as well; its requirements are listed in the [Part 2 intro](#part-2--github-triggered-runs) so you don't have to set it up before you've seen your first run.

## Part 1 — your first run

### 1. Sign up at app.kici.dev

Go to [app.kici.dev](https://app.kici.dev) and create an account. Self-service sign-up is limited during the beta; see the [Docker quickstart](./compose.md#1-sign-up-at-appkicidev) for the beta-invite path.

After sign-up you'll have a personal organisation.

### 2. Mint an orchestrator registration token

In the dashboard, open **Settings → Orchestrators → New orchestrator**, name it (e.g. `home-server`), and copy the `kici_ok_…` token. The token is shown **only once** — save it now. This authorises your orchestrator to connect to `wss://api.kici.dev/ws`.

### 3. Set up PostgreSQL and the orchestrator's database

The orchestrator stores runs, sources, secrets, and its job queue in PostgreSQL 18. Pick **one** of the two options below — the orchestrator itself still runs as a native service either way; only how you run the database differs. Both options end with the database reachable at `127.0.0.1:5432` as role `kici` / database `kici`, using the loopback-only stub password `kici-local` that the step 5 env template already points at.

#### Option A — PostgreSQL in a container (recommended)

Even on a bare-metal orchestrator host, the least-fiddly way to run the database is a single container: no apt repository juggling, no `pg_hba.conf` editing, and a clean teardown with one command. This option needs `docker` (or `podman`) with `docker compose`.

```bash
mkdir -p ~/.config/kici

# Download the backing-services compose (PostgreSQL + SeaweedFS) and the
# static S3 identity SeaweedFS mounts. Both publish on loopback only.
curl -o ~/.config/kici/docker-compose.postgres.yaml \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/docker-compose.postgres.yaml
curl -o ~/.config/kici/seaweedfs-s3.json \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/seaweedfs-s3.json

# --wait blocks until both healthchecks pass, so the verify below is reliable.
# The DB password defaults to the loopback-only stub `kici-local` (export
# POSTGRES_PASSWORD=… first if you want a different value); the env file in
# step 5 already points at it.
docker compose -f ~/.config/kici/docker-compose.postgres.yaml up -d --wait

# Verify connectivity using the container's own psql (no host psql needed).
docker compose -f ~/.config/kici/docker-compose.postgres.yaml exec postgres \
  psql -U kici -d kici -c 'SELECT 1;'
```

The compose publishes PostgreSQL on `127.0.0.1:5432` and a SeaweedFS object store on `127.0.0.1:8333`, so the orchestrator (a native process on the same host) connects to both exactly as it would native installs. SeaweedFS is what makes `kici run remote` work in step 8. To stop or remove these later: `docker compose -f ~/.config/kici/docker-compose.postgres.yaml down` (add `-v` to also wipe the data volumes).

:::note[macOS]
On **Docker Desktop** these containers and their loopback ports work out of the box. On **podman machine**, the runtime runs in a VM — `podman machine init && podman machine start` first, then `docker compose`/`podman compose` against it as shown. The `127.0.0.1:5432` and `127.0.0.1:8333` published ports are forwarded to the macOS host, so the native orchestrator and `kici` CLI reach them at `localhost` exactly as on Linux.
:::

#### Option B — Native PostgreSQL install

If you already manage PostgreSQL natively (or prefer to), install it from your package manager instead. Only the database is native in this option — `kici run remote` still needs the SeaweedFS object store, so you'll bring up just that one container at the end.

```bash
sudo apt update
sudo apt install -y postgresql-18 postgresql-contrib

# Create the kici DB + role with the loopback-only stub password the step 5
# env template already points at. (Override it here and in step 5 if you'd
# rather use your own — this Postgres only listens on 127.0.0.1.)
sudo -u postgres psql -c "CREATE USER kici WITH PASSWORD 'kici-local';"
sudo -u postgres createdb -O kici kici

# Verify connectivity from your shell.
PGPASSWORD=kici-local psql -h 127.0.0.1 -U kici -d kici -c 'SELECT 1;'
```

PostgreSQL listens on `127.0.0.1:5432` by default. If you'd rather use a different port or a remote DB, adjust `KICI_DATABASE_URL` in step 5 accordingly.

:::note[macOS]
Use Homebrew instead of apt: `brew install postgresql@18 && brew services start postgresql@18`, then `psql -d postgres -c "CREATE USER kici WITH PASSWORD 'kici-local';"` and `createdb -O kici kici` (no `sudo -u postgres` on macOS).
:::

Now bring up the SeaweedFS object store (the only container Option B needs). It reuses the same compose file as Option A, starting only the `seaweedfs` service:

```bash
mkdir -p ~/.config/kici
curl -o ~/.config/kici/docker-compose.postgres.yaml \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/docker-compose.postgres.yaml
curl -o ~/.config/kici/seaweedfs-s3.json \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/seaweedfs-s3.json

# Start only the seaweedfs service (the postgres service stays
# defined-but-unstarted; its stub-password default means no env is needed).
docker compose -f ~/.config/kici/docker-compose.postgres.yaml up -d --wait seaweedfs
```

SeaweedFS is now published on `127.0.0.1:8333` — the same endpoint the env file in step 5 already points at.

### 4. Install the `kici-admin` CLI

```bash
npm install -g kici-admin
kici-admin --version
```

This pulls in `@kici-dev/orchestrator` transitively and exposes the `kici-admin` binary on your `PATH`.

### 5. Prepare the orchestrator env file

Download the bare-metal env template and fill in the three placeholder values:

```bash
mkdir -p ~/.config/kici
curl -o ~/.config/kici/kici-orchestrator.env \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/.env.example

# Edit the file — the three values you need to fill in are:
#   KICI_PLATFORM_TOKEN          ← from step 2 (kici_ok_…)
#   KICI_SECRET_KEY              ← openssl rand -hex 32 (64 hex chars)
#   KICI_BOOTSTRAP_ADMIN_TOKEN   ← openssl rand -hex 32
# KICI_DATABASE_URL is already filled in with the loopback stub password
# from step 3 — leave it unless you chose a custom password.
${EDITOR:-vi} ~/.config/kici/kici-orchestrator.env
```

The template already carries the `KICI_STORAGE_*` block wired to the SeaweedFS container from step 3 (`http://localhost:8333`, bucket `kici-cache`) — nothing to fill in there. That's what lets `kici run remote` work in step 8.

### 6. Install the orchestrator as a managed service

```bash
kici-admin orchestrator install --env-file ~/.config/kici/kici-orchestrator.env
kici-admin orchestrator start

# Tail the logs and confirm it boots cleanly.
kici-admin orchestrator logs --follow
```

Within ~5 seconds you should see:

```
[orchestrator] connected to platform api.kici.dev (registration <id>)
[orchestrator] listening on :4000
```

`Ctrl-C` to stop tailing; the service keeps running. Check it any time with `kici-admin orchestrator status`.

:::note[macOS]
`kici-admin orchestrator install` auto-detects the platform and uses **launchd** on macOS (systemd on Linux). Every `kici-admin orchestrator …` lifecycle command in this guide is identical on both.
:::

### 7. Configure the bare-metal scaler

The bare-metal scaler launches an agent process on the same host whenever a job arrives and tears it down when the job finishes. No long-running agent service to manage — agents come and go per-job.

Create a scaler config alongside the orchestrator env file:

```bash
cat > ~/.config/kici/scalers.yaml <<EOF
version: 1
globalMaxAgents: 4

scalers:
  - name: bare-metal-linux
    type: bare-metal
    maxAgents: 4
    labelSets:
      - labels: [linux, bare-metal]
        binaryPath: $(command -v kici-agent)
EOF
```

`$(command -v kici-agent)` is evaluated by your shell when the heredoc is written, so the absolute path to the `kici-agent` binary installed in step 4 lands in the file. Inspect the result with `cat ~/.config/kici/scalers.yaml` — `binaryPath:` should point at something like `/usr/local/bin/kici-agent` (or whichever prefix your `npm install -g` uses).

Point the orchestrator at the scaler config and restart it:

```bash
echo "KICI_SCALER_CONFIG_PATH=$HOME/.config/kici/scalers.yaml" >> ~/.config/kici/kici-orchestrator.env
kici-admin orchestrator restart
```

Tail the orchestrator log to confirm the scaler loaded:

```bash
kici-admin orchestrator logs --follow
```

Within a couple of seconds you should see:

```
[orchestrator] scaler bare-metal-linux loaded (type=bare-metal, maxAgents=4, labels=linux,bare-metal)
```

The first agent process will spawn when you run your first workflow (step 8).

#### Optional — run both scaler types

If you want some jobs to run in fully-isolated containers and others to run as
native host processes, run both scaler backends from one config. Download the
dual-scaler example and point `binaryPath` at your installed agent:

```bash
curl -o ~/.config/kici/scalers.yaml \
  https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/bare-metal/scalers.dual.yaml
sed -i "s#binaryPath:.*#binaryPath: $(command -v kici-agent)#" ~/.config/kici/scalers.yaml
kici-admin orchestrator restart
```

`globalMaxAgents` caps the combined concurrent agents across both scalers.
Jobs route by label: a job whose `runsOn` includes `container` lands on the
container scaler (which pulls `quay.io/kici-dev/kici-agent`), while a job whose
`runsOn` includes `bare-metal` lands on the host-process scaler. Two notes when
the orchestrator runs as an unprivileged (user-level) service:

- Set `networkIsolation: false` on the container scaler — the per-agent network
  firewall needs privileges a user-level process doesn't have.
- Spawned agent containers must be able to reach the orchestrator's port on the
  host. The `host.docker.internal` alias (with the `extraHosts` line in the
  example) resolves on Docker Desktop and Podman 4+; on a plain host you can
  instead set `orchestratorUrl` to the host's LAN address.

### 8. Run a workflow without pushing

The SeaweedFS container from step 3 lets you run a workflow against your orchestrator straight from your working tree — no GitHub App, no git push. The fastest way to confirm the pipeline works, and the milestone Part 1 is built around.

```bash
# A throwaway git repo to hold the workflow. `kici run remote` reads your
# working tree on top of a commit, so the folder must be a git repo with at
# least one commit.
mkdir -p hello-kici/.kici/workflows hello-kici/.kici/tests && cd hello-kici
git init -q -b main
printf 'node_modules/\n' > .gitignore

# `.kici/package.json` declares the SDK. The compiler (on your machine) resolves
# `@kici-dev/sdk` from .kici/node_modules after the `npm install` below. The agent
# (the spawned host process) gets the SAME node_modules at run time: `kici run remote`
# uploads the git-tracked working tree (package.json included; node_modules is
# gitignored and stays local), then the agent runs `npm install` in .kici/ on its side
# and resolves the SDK from the result. The gitignore is intentional — the agent
# rebuilds node_modules from package.json rather than receiving yours over the wire.
cat > .kici/package.json <<'EOF'
{
  "name": "hello-kici-workflows",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@kici-dev/sdk": "^0.1.18"
  }
}
EOF

cat > .kici/workflows/hello.ts <<'EOF'
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('hello', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('greet', {
      runsOn: 'bare-metal',
      steps: [
        step('say hi', async ({ $ }) => {
          await $`echo "Hello from KiCI 👋"`;
        }),
      ],
    }),
  ],
});
EOF

cat > .kici/tests/push.ts <<'EOF'
import { fixture, push } from '@kici-dev/sdk';
export const pushMain = fixture('push-main', { event: push({ branches: ['main'] }) });
EOF

# Install the SDK and make the first commit (run remote needs a HEAD commit).
( cd .kici && npm install )
git add -A && git commit -q -m "hello kici"

# Install the developer CLI, log in to the Platform, and select your org.
npm install -g kici
kici login
kici org use <your-org>

kici compile
kici run remote push-main
```

You should see a green `push-main … success` run in your terminal — the bare-metal scaler spawned a one-shot agent process on this host, which fetched your working tree from SeaweedFS and ran the step. **That's Part 1 done — a workflow run end-to-end on your own box, with no GitHub App in sight.** Keep this `hello-kici/.kici/` folder around: Part 2 reuses it.

`kici run remote` uses two planes. The **control plane** (run initiation, status, logs, cancellation) flows from your machine through the Platform, which relays it over a WebSocket connection to your orchestrator. The **data plane** — your working-tree overlay — uploads **directly** from your machine to SeaweedFS via a presigned URL and never passes through the Platform. That direct upload is what the `KICI_STORAGE_*` block from step 5 (`http://localhost:8333`) enables.

With a single connected orchestrator the Platform selects it automatically. If your org later connects more than one, list them with `kici orchestrators list` and pin a default with `kici orchestrators use <name>` (or pass `--orchestrator <name>` per run).

The workflow uses `runsOn: 'bare-metal'` to match the scaler's `[linux, bare-metal]` label set from step 7.

## Part 2 — GitHub-triggered runs

Part 1 got you a green run without GitHub. Part 2 connects real GitHub pushes so your team's commits trigger runs automatically. Allow ~10 minutes — registering a GitHub App and wiring the webhook is the slowest part of the whole quickstart.

You'll need, in addition to the Part 1 prerequisites:

- A GitHub repository you can install a GitHub App on.
- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) you've created for that repository. You need two things from it:
  - its **App ID** (shown on the App's settings page), and
  - a **private key** (`.pem`) — click _Generate a private key_ and save the download.

  Leave the App's **Webhook URL** field blank for now — you'll generate that URL in step 9 ("Register your GitHub App as a webhook source") and paste it back into GitHub then.

### 9. Register your GitHub App as a webhook source

`<YOUR_APP_ID>` and the `.pem` are the two values from the [Part 2 intro](#part-2--github-triggered-runs); the **Webhook URL** the command prints below is what you paste into the App's blank Webhook URL field in the next step.

```bash
# The bootstrap admin token is in the env file you wrote in step 5.
ADMIN_TOKEN=$(grep '^KICI_BOOTSTRAP_ADMIN_TOKEN=' ~/.config/kici/kici-orchestrator.env | cut -d= -f2)

kici-admin --url http://127.0.0.1:4000 --token "$ADMIN_TOKEN" \
  source add github \
  --name my-org \
  --app-id <YOUR_APP_ID> \
  --private-key @./github-app-private-key.pem \
  --webhook-secret <YOUR_WEBHOOK_SECRET>
```

Same shape as step 6 of the [Docker quickstart](./compose.md#6-register-your-github-app-as-a-webhook-source). The command prints the public webhook URL the Platform now accepts for this source.

### 10. Wire GitHub to the webhook URL

In your GitHub App's settings:

- **Webhook URL**: the URL printed above.
- **Webhook secret**: the same `--webhook-secret` you passed in step 9.
- **Subscribe to events**: at minimum `push` and `pull_request`.

Click **Save changes** in GitHub.

### 11. Push a commit

This step reuses the `.kici/` scaffold from Part 1. In a repo that has the GitHub App installed, either copy the `hello-kici/.kici/` folder you built in step 8 (its `package.json` + `workflows/hello.ts` + `tests/push.ts`) into the repo, or run `kici init` to scaffold an equivalent `.kici/` from scratch. Then compile and push:

```bash
# (Bring in the .kici/ folder from step 8, or run `kici init`.)
kici compile
git add .kici/ && git commit -m "ci: hello-world workflow" && git push
```

Watch the run in the dashboard's **Runs** page. This time the trigger came from GitHub: the push hit the Platform, which relayed it to your orchestrator, whose bare-metal scaler spawned a one-shot agent process to clone the repo and run the step.

## Service lifecycle

Agents are spawned on demand by the orchestrator's scaler — there is no agent systemd unit to manage. To pause job dispatch, stop the orchestrator. To inspect a running or completed agent, use the dashboard's **Runs** page or `kici-admin runs show <runId>`.

```bash
# Status
kici-admin orchestrator status

# Stop / start / restart
kici-admin orchestrator stop
kici-admin orchestrator start
kici-admin orchestrator restart

# Uninstall (removes the service; does not touch the env file, DB, or scalers.yaml).
kici-admin orchestrator uninstall
```

## Upgrading

When a new KiCI version ships:

```bash
npm install -g kici-admin@latest
kici-admin orchestrator restart
```

`kici-admin orchestrator restart` re-launches the orchestrator from the freshly-installed binary. Scaler-spawned agents pick up the new agent code on the next job — they respawn fresh from `$(command -v kici-agent)` every time, so a global `kici-admin` upgrade is all that's needed. DB migrations run automatically on first start of the new version.

:::caution[Don't re-run `install` to upgrade]
The service unit already points at the global `kici-admin` package, so the `npm install` + `restart` above is the whole upgrade. Re-running `kici-admin orchestrator install` against an already-installed service is **not** the upgrade path — it's for first-time setup, and against an existing same-named instance it stops with `an orchestrator instance "…" is already installed`. If you see that error, you only needed `kici-admin orchestrator restart`.
:::

## Where to next

- **Switch to Docker / Podman** — if you'd rather not maintain the systemd / Postgres install yourself, the [Docker quickstart](./compose.md) achieves the same end state with containers.
- **Run more without pushing** — `kici run remote` (step 8) runs any fixture against this orchestrator from your local working tree, including uncommitted changes — backed by the SeaweedFS store you set up in step 3. See the [testing guide](../testing-guide.md) for fixtures, secret contexts, and more.
- **Advanced service configuration** — env vars beyond the basics, multi-instance setups, log rotation, run-as-root for Firecracker. See [Service installation](../../operator/distribution/service-installation.md).
- **Tune the scaler** — add label sets for additional runtimes, enable warm pools to pre-spawn agents, set per-job CPU / memory limits, gate specialised hardware behind mandatory labels, or run multiple scaler types on the same host. See [Auto-scaler overview](../../operator/orchestrator/auto-scaler.md), [Common configuration](../../operator/orchestrator/auto-scaler/common-config.md), and the [Bare-metal backend](../../operator/orchestrator/auto-scaler/bare-metal.md).

## Troubleshooting

**First `docker compose pull` / `up` fails with `toomanyrequests` (Docker Hub rate limit).** The backing PostgreSQL (Option A) and SeaweedFS images pull from Docker Hub, which rate-limits anonymous pulls by source IP. Authenticate with `docker login` (a free Docker Hub account raises the limit), wait a few minutes for the window to reset and retry, or point your runtime at a Docker Hub mirror / pull-through cache. The `kici-admin` / `kici` packages come from npm and the agent binary is local, so this only affects the container step.

**Orchestrator service fails to start with `KICI_DATABASE_URL` not set.** The env file at `~/.config/kici/kici-orchestrator.env` is missing or unreadable by the systemd user manager. `cat ~/.config/kici/kici-orchestrator.env` from your shell — if it lists the keys, run `systemctl --user daemon-reload && kici-admin orchestrator restart`. If it doesn't, you skipped step 5.

**Auth failure to PostgreSQL on first start.** By default both the database and `KICI_DATABASE_URL` (step 5) use the loopback stub `kici-local`, so this only happens if you chose a custom password. With **Option A** (container), the password is baked into the data volume at first boot — if you set a custom `POSTGRES_PASSWORD` after the volume was created, the old password still applies; `docker compose -f ~/.config/kici/docker-compose.postgres.yaml down -v` wipes the volume so a new one takes effect. With **Option B** (native), either the role password doesn't match `KICI_DATABASE_URL`, or `pg_hba.conf` is configured to reject `127.0.0.1` connections — on Debian/Ubuntu the default `pg_hba.conf` accepts loopback with `scram-sha-256`; if you've edited it, restore `host all all 127.0.0.1/32 scram-sha-256`.

**Orchestrator logs show `auth.failed` against api.kici.dev.** The `KICI_PLATFORM_TOKEN` in the env file doesn't match what you minted in step 2. Mint a fresh one and update the env file; then `kici-admin orchestrator restart`.

**`kici-admin source add` returns 401 / 403.** The `--token` you passed doesn't match `KICI_BOOTSTRAP_ADMIN_TOKEN` in the orchestrator's env file. Re-extract it with `grep '^KICI_BOOTSTRAP_ADMIN_TOKEN=' ~/.config/kici/kici-orchestrator.env`.

**Push happens but no agent spawns.** Tail `kici-admin orchestrator logs --follow` immediately after the push and look near the top for one of three failure modes:

- `scaler config parse error`: the YAML in `~/.config/kici/scalers.yaml` didn't validate. Re-read the file (`cat ~/.config/kici/scalers.yaml`) — most often `binaryPath:` is empty because `$(command -v kici-agent)` evaluated to nothing at heredoc-write time, which means step 4's `npm install -g kici-admin` didn't put `kici-agent` on PATH. Re-run `command -v kici-agent` from your shell to confirm; if it's empty, re-install with `npm install -g kici-admin@latest` and regenerate the file.
- `KICI_SCALER_CONFIG_PATH not set` (or the orchestrator boots without loading any scaler): the env-file line you appended in step 7 didn't take effect. The value MUST be an absolute path — systemd env files do NOT expand `~` or `$HOME`. Re-check with `grep '^KICI_SCALER_CONFIG_PATH=' ~/.config/kici/kici-orchestrator.env`; it should look like `KICI_SCALER_CONFIG_PATH=/home/<you>/.config/kici/scalers.yaml`. If it has `~` or `$HOME`, rewrite the line and `kici-admin orchestrator restart`.
- `scaler spawn failed: ENOENT`: the orchestrator loaded the config but the `binaryPath:` doesn't exist (someone moved or uninstalled `kici-agent` between heredoc and now). Re-resolve and rewrite the file.

**Push happens but no run appears in the dashboard.** Either GitHub didn't deliver the webhook (check the App's "Recent deliveries" tab in GitHub's settings — look for 4xx responses), or the orchestrator received it but no workflow matched. Run `kici test push` against your workflow file to confirm a `push` to your branch would trigger something.
