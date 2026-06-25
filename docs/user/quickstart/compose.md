---
title: 'Quickstart: Docker / Podman'
description: Bring up a KiCI orchestrator with on-demand agent containers via docker compose, connected to the public Platform relay
---

This guide brings up a working KiCI orchestrator using `docker compose` (or `podman compose`), connected to the public Platform relay. It's in two parts:

- **Part 1 — your first run, no GitHub needed (~5 min):** sign up, mint a token, bring up the stack, and run a workflow against your orchestrator straight from your working tree with `kici run remote`. This is the fast path to a green run.
- **Part 2 — GitHub-triggered runs (~10 min):** register a GitHub App, wire the webhook, and push a commit so your team's pushes trigger runs automatically.

If you'd rather run native systemd services, see the [bare-metal quickstart](./bare-metal.md). For the chooser overview, see [Choose your path](../quickstart.md).

You'll end up with:

- A KiCI **orchestrator** running on your machine (or a tiny VM), configured to spawn agent containers on demand via the container scaler.
- Connected to the **public Platform** at `api.kici.dev`, which receives GitHub webhooks and relays them to your orchestrator over an outbound WebSocket. **No inbound port needs to be exposed on your side** — the orchestrator opens the connection.
- A first workflow run you trigger yourself (Part 1), and then real GitHub pushes triggering runs automatically (Part 2), with logs visible in the dashboard at `https://app.kici.dev`.

## Prerequisites

- `docker` (or `podman`) with `docker compose` (or `podman compose`) available — version 2.20+ recommended. On macOS use Docker Desktop, or `podman machine` (`podman machine init && podman machine start`).
- An account at [app.kici.dev](https://app.kici.dev) — you'll create one in step 1.
- About 5 minutes for Part 1.

Part 2 (GitHub-triggered runs) needs a GitHub App as well; its requirements are listed in the [Part 2 intro](#part-2--github-triggered-runs) so you don't have to set it up before you've seen your first run.

## Part 1 — your first run

### 1. Sign up at app.kici.dev

Go to [app.kici.dev](https://app.kici.dev) and create an account.

:::note[Beta access]
Self-service sign-up is limited during the beta. If the dashboard shows a "waitlist" message, open a [GitHub issue](https://github.com/kici-dev/kici-public/issues) titled "beta invite request" and we'll send you an invite — usually within a business day.
:::

After sign-up you'll have a personal organisation. Future-you can invite teammates and create additional orgs from the dashboard.

### 2. Mint an orchestrator registration token

In the dashboard, open **Settings → Orchestrators → New orchestrator**, give it a name (e.g. `home-server`), and copy the token the dialog shows. The token starts with `kici_ok_` and is shown **only once** — save it now.

This token authorises your orchestrator to connect to `wss://api.kici.dev/ws` and identify itself as belonging to your organisation.

### 3. Download the compose template

```bash
mkdir my-kici && cd my-kici
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/docker-compose.yaml
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/scalers.yaml
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/seaweedfs-s3.json
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/.env.example
cp .env.example .env
```

`docker-compose.yaml` brings up the orchestrator, a local Postgres, and a SeaweedFS object store (so `kici run remote` works locally — see step 5). `scalers.yaml` declares the container scaler — when a job arrives, the orchestrator spawns a one-shot agent container on this host, the job runs inside it, and the container is destroyed when the job finishes. `seaweedfs-s3.json` is the SeaweedFS credential config the compose mounts.

Open `.env` in your editor and fill in the three values:

- `KICI_PLATFORM_TOKEN` — the `kici_ok_…` token from step 2.
- `KICI_SECRET_KEY` — `openssl rand -hex 32` (must be 64 hex chars; encrypts secrets at rest).
- `KICI_BOOTSTRAP_ADMIN_TOKEN` — `openssl rand -hex 32` (first-time admin token for the `kici-admin` CLI).

`POSTGRES_PASSWORD` is optional — it defaults to the local-only stub `kici-local` (Postgres isn't published outside the compose network). Set it in `.env` only if you want a custom password.

### 4. Boot the stack

```bash
docker compose up -d
docker compose logs -f orchestrator
```

You should see something like this within ~5 seconds:

```
[orchestrator] connected to platform api.kici.dev (registration <id>)
[orchestrator] listening on :4000
[orchestrator] scaler container-default loaded (type=container, maxAgents=4, labels=linux,container)
```

`Ctrl-C` to stop tailing logs; the stack keeps running in the background.

The dashboard's **Orchestrators** page now shows your registration as **online**. No agent container is running yet — the scaler will spawn one when your first job arrives in step 5.

:::note[Container socket trust]
`docker-compose.yaml` bind-mounts the host's container runtime socket (`/var/run/docker.sock`) into the orchestrator so it can spawn agent containers per job. This grants the orchestrator the ability to manage other containers on this host — the same trust boundary as any CI runner that uses a Docker-in-Docker pattern.
:::

:::note[macOS]
On **Docker Desktop**, `/var/run/docker.sock` and `host.docker.internal` work out of the box. On **podman machine**, the runtime socket lives inside the VM — run `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` and bind-mount that path in `docker-compose.yaml` in place of `/var/run/docker.sock`; `host.docker.internal` still resolves via the `extraHosts` line in `scalers.yaml`.

The `podman machine` VM runs SELinux in enforcing mode, which blocks the orchestrator container from reading the bind-mounted socket (`EACCES` at boot). Add `security_opt: [label=disable]` to the `orchestrator` service in `docker-compose.yaml` to lift the relabeling requirement for that one container. Docker Desktop does not need this.
:::

### 5. Run a workflow without pushing

The stack includes a SeaweedFS object store, so you can run a workflow against your local orchestrator straight from your working tree — no GitHub App, no git push, no webhook. This is the fastest way to confirm the whole pipeline works, and it's the milestone Part 1 is built around.

```bash
# A throwaway git repo to hold the workflow (any folder with a .kici/ works).
# `kici run remote` reads your working tree on top of a commit, so the folder
# must be a git repo with at least one commit.
mkdir -p hello-kici/.kici/workflows hello-kici/.kici/tests && cd hello-kici
git init -q -b main
printf 'node_modules/\n' > .gitignore

# `.kici/package.json` declares the SDK. The compiler (on your machine) resolves
# `@kici-dev/sdk` from .kici/node_modules after the `npm install` below. The agent
# (inside the spawned container) gets the SAME node_modules at run time: `kici run
# remote` uploads the git-tracked working tree (package.json included; node_modules
# is gitignored and stays local), then the agent runs `npm install` in .kici/ on its
# side and resolves the SDK from the result. The gitignore is intentional — the agent
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
      runsOn: 'linux',
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

# Run it — `kici run remote` recompiles your workflows first, then routes the run
# through the Platform to your orchestrator, the CLI uploads your working tree
# directly to SeaweedFS, the scaler spawns a one-shot agent container, and logs
# stream back to your terminal.
kici run remote push-main
```

You should see a green `push-main … success` run in your terminal. **That's Part 1 done — a workflow run end-to-end on your own box, with no GitHub App in sight.** Keep this `hello-kici/.kici/` folder around: Part 2 reuses it.

`kici run remote` uses two planes. The **control plane** (run initiation, status, logs, cancellation) flows from your machine through the Platform, which relays it over a WebSocket connection to your local orchestrator. The **data plane** — your working-tree overlay — uploads **directly** from your machine to SeaweedFS via a presigned URL and never passes through the Platform. That direct upload is exactly what `KICI_STORAGE_UPLOAD_ENDPOINT=http://localhost:8333` enables: the host CLI uploads to `localhost:8333`, the orchestrator hands the agent a container-routable URL (`host.docker.internal:8333`), and the agent fetches the overlay before running your steps.

With a single connected orchestrator the Platform selects it automatically. If your org later connects more than one, list them with `kici orchestrators list` and pin a default with `kici orchestrators use <name>` (or pass `--orchestrator <name>` per run).

See the [testing guide](../testing-guide.md) for fixtures, secret contexts, and more.

## Part 2 — GitHub-triggered runs

Part 1 got you a green run without GitHub. Part 2 connects real GitHub pushes so your team's commits trigger runs automatically. Allow ~10 minutes — registering a GitHub App and wiring the webhook is the slowest part of the whole quickstart.

You'll need, in addition to the Part 1 prerequisites:

- A GitHub repository you can install a GitHub App on.
- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) you've created for that repository. You need two things from it:
  - its **App ID** (shown on the App's settings page), and
  - a **private key** (`.pem`) — click _Generate a private key_ and save the download.

  Leave the App's **Webhook URL** field blank for now — you'll generate that URL in step 6 ("Register your GitHub App as a webhook source") and paste it back into GitHub then.

### 6. Register your GitHub App as a webhook source

`<YOUR_APP_ID>` and the `.pem` are the two values from the [Part 2 intro](#part-2--github-triggered-runs); the **Webhook URL** the command prints below is what you paste into the App's blank Webhook URL field in the next step.

From the same machine you started the stack on:

```bash
npm install -g kici-admin

kici-admin --url http://localhost:4000 --token "$KICI_BOOTSTRAP_ADMIN_TOKEN" \
  source add github \
  --name my-org \
  --app-id <YOUR_APP_ID> \
  --private-key @./github-app-private-key.pem \
  --webhook-secret <YOUR_WEBHOOK_SECRET>
```

Replace `<YOUR_APP_ID>` with the App ID from your GitHub App's settings page, point `--private-key` at the `.pem` you downloaded from GitHub, and use any random string for `--webhook-secret` (you'll paste the same string into the GitHub App's webhook config in the next step).

The command prints the **public webhook URL** the Platform now accepts for this source:

```
Source added: github:<appId> (my-org)
Webhook URL:  https://api.kici.dev/webhook/<orgId>/github
  ↳ Paste this into your GitHub App's "Webhook URL" field.
```

### 7. Wire GitHub to the webhook URL

In your GitHub App's settings:

- **Webhook URL**: the URL printed above.
- **Webhook secret**: the same `--webhook-secret` you passed in step 6.
- **Subscribe to events**: at minimum `push` and `pull_request`.

Click **Save changes** in GitHub.

### 8. Push a commit

This step reuses the `.kici/` scaffold from Part 1. In a repo that has the GitHub App installed, either copy the `hello-kici/.kici/` folder you built in step 5 (its `package.json` + `workflows/hello.ts` + `tests/push.ts`) into the repo, or run `kici init` to scaffold an equivalent `.kici/` from scratch. Then compile and push:

```bash
# (Bring in the .kici/ folder from step 5, or run `kici init`.)
kici compile
git add .kici/ && git commit -m "ci: hello-world workflow" && git push
```

Watch the run light up in the **Runs** page of the dashboard. This time the trigger came from GitHub: the push hit the Platform, which relayed it to your orchestrator, which spawned a one-shot agent container to clone the repo and run the step.

## What just happened

```
GitHub                Platform (api.kici.dev)              your box
  │                          │                                 │
  │ POST /webhook/...        │                                 │
  ├─────────────────────────►│                                 │
  │                          │  WebSocket relay (outbound)     │
  │                          │◄────────────────────────────────│ orchestrator
  │                          │                                 │       │ scaler.spawn()
  │                          │                                 │       ▼
  │                          │                                 │     agent container
  │                          │                                 │       │ git clone + run steps
  │                          │  log chunks + status            │       │
  │                          │◄────────────────────────────────│       │
  │                          │                                 │       ▼ (destroyed on exit)
  dashboard reads run state from Platform
```

The Platform handles webhook ingress + signature verification + audit logging. Your orchestrator owns the trigger matching, job queue, and per-source secrets — and spawns one agent container per job via the bind-mounted container runtime socket. Each agent runs exactly one job, then exits.

## Upgrading

When a new KiCI version ships, the published `quay.io/kici-dev/kici-orchestrator` and `quay.io/kici-dev/kici-agent` images move to the new tag and the compose template pins it. Re-download the template, pull, and recreate the stack:

```bash
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/docker-compose.yaml
docker compose pull
docker compose up -d
```

`docker compose up -d` recreates the orchestrator from the newer pinned image; your `.env`, the Postgres volume, and `scalers.yaml` are left untouched. Agent containers respawn from the new agent image on the next job, and DB migrations run automatically on first start of the new version.

## Where to next

- **Write more workflows** — see the [SDK reference](../sdk-reference.md) for triggers, jobs, conditionals, matrices, and dynamic values.
- **Test before pushing** — `kici test pr:open` previews which workflows would fire for a given event; `kici run local` executes a workflow against your laptop without any infrastructure. See [Getting started](../getting-started.md). To run your local working tree through _this_ orchestrator without a git push, use `kici run remote` (step 5 above) — it works out of the box here thanks to the bundled SeaweedFS store. See the [testing guide](../testing-guide.md).
- **Switch to bare metal** — if you'd rather run native systemd services without a container runtime, see the [bare-metal quickstart](./bare-metal.md).
- **Tune the scaler** — add label sets for additional runtimes, enable warm pools to pre-spawn agents, set per-job CPU / memory limits, gate specialised hardware behind mandatory labels, or point the scaler at a remote container daemon. See [Auto-scaler overview](../../operator/orchestrator/auto-scaler.md), [Common configuration](../../operator/orchestrator/auto-scaler/common-config.md), and the [Container backend](../../operator/orchestrator/auto-scaler/container.md).
- **Run isolated** — Firecracker microVM execution for untrusted code or per-job isolation. See [Firecracker setup](../../operator/orchestrator/firecracker-setup.md).

## Troubleshooting

**First `docker compose pull` / `up` fails with `toomanyrequests` (Docker Hub rate limit).** The backing PostgreSQL and SeaweedFS images pull from Docker Hub, which rate-limits anonymous pulls by source IP. Authenticate with `docker login` (a free Docker Hub account raises the limit), wait a few minutes for the window to reset and retry, or point your runtime at a Docker Hub mirror / pull-through cache. The orchestrator and agent images come from `quay.io` and are unaffected.

**Orchestrator logs show `auth.failed` immediately after start.** The `KICI_PLATFORM_TOKEN` in `.env` doesn't match what you minted at app.kici.dev. Mint a fresh one (the old one stays revokable from the dashboard) and update `.env`, then `docker compose restart orchestrator`.

**SeaweedFS keeps restarting, or `kici run remote` can't upload the overlay.** `docker compose ps` shows the `seaweedfs` service unhealthy or restarting. Tail its logs with `docker compose logs seaweedfs` — if you see `fail to load config file /etc/seaweedfs/s3.json: … is a directory`, then `seaweedfs-s3.json` is a **directory**, not a file. The `curl -O …seaweedfs-s3.json` download in step 3 was skipped or failed, so `docker compose up` created an empty directory at the bind-mount path and SeaweedFS exits on startup. From your `my-kici` directory, remove the directory, re-download the file, confirm it's a file, and recreate the container:

```bash
rm -rf seaweedfs-s3.json
curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/seaweedfs-s3.json
test -f seaweedfs-s3.json && echo "ok: it is a file"
docker compose up -d --force-recreate seaweedfs
```

**`kici run remote` fails to upload with `Failed to parse URL from` or `no object storage configured`.** The orchestrator has no object storage wired. The bundled `docker-compose.yaml` ships the `KICI_STORAGE_*` settings on the `orchestrator` service's `environment:` block, so this only happens if that file was edited or replaced. Confirm the keys are still there with `grep KICI_STORAGE_ docker-compose.yaml` — you should see `KICI_STORAGE_TYPE`, `KICI_STORAGE_ENDPOINT`, `KICI_STORAGE_UPLOAD_ENDPOINT`, `KICI_STORAGE_EXTERNAL_ENDPOINT`, and `KICI_STORAGE_BUCKET` (plus `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). If they're missing, re-download the file from the [kici-public repo](https://github.com/kici-dev/kici-public/blob/main/examples/quickstart/compose/docker-compose.yaml) and `docker compose up -d`.

**`kici run remote` uploads, but the job fails with `Overlay download failed … ECONNREFUSED …:8333`.** The CLI upload succeeded (the host reaches `localhost:8333`), but the spawned agent container can't fetch the overlay back. The tell-tale: the failure is on the agent/job — not the CLI upload — and the URL host is `localhost` or `127.0.0.1`. A spawned agent container runs in its own network namespace, so a presigned URL pointing at `localhost:8333` resolves to the container's own empty loopback (`ECONNREFUSED`). The bundled `docker-compose.yaml` already avoids this: it sets `KICI_STORAGE_EXTERNAL_ENDPOINT=http://host.docker.internal:8333` (the address the scaler's `host.docker.internal:host-gateway` alias routes to the host) and publishes SeaweedFS on `8333:8333`. If you hit this, confirm both are intact with `grep -E 'KICI_STORAGE_EXTERNAL_ENDPOINT|8333:8333' docker-compose.yaml`; restore them from the [kici-public repo](https://github.com/kici-dev/kici-public/blob/main/examples/quickstart/compose/docker-compose.yaml) if either was removed, then `docker compose up -d`.

**`kici run remote` runs but reports `No jobs dispatched`.** The job's `runsOn` label matches no agent your scaler can provide, so the orchestrator rejects the dispatch. A `runsOn` value must match either a **custom label your scaler declares** — the container scaler in `scalers.yaml` offers `linux` plus `container` — or an **auto-label every agent carries automatically**, such as `kici:os:linux` (the agent's operating system), which is what `kici init`'s starter workflows use. A value like `ubuntu-latest` matches neither and never dispatches. Set the job's `runsOn` to one of your scaler's labels (for example `'container'`) or an auto-label (for example `'kici:os:linux'`), then `kici compile` and re-run.

**Push happens but no agent container spawns.** Tail `docker compose logs -f orchestrator` immediately after the push and look near the top for one of three failure modes:

- `scaler spawn failed: Cannot connect to the Docker daemon` (or `permission denied`): the orchestrator can't reach `/var/run/docker.sock`. On **rootless Podman** the socket lives at `$XDG_RUNTIME_DIR/podman/podman.sock` instead — edit `docker-compose.yaml` to swap the bind-mount (e.g. `- /run/user/1000/podman/podman.sock:/var/run/docker.sock`) and `docker compose up -d` again. Enable the podman user socket first with `systemctl --user enable --now podman.socket` if it isn't already running.
- `scaler config parse error`: `scalers.yaml` didn't validate. Re-download from the [kici-public repo](https://github.com/kici-dev/kici-public/blob/main/examples/quickstart/compose/scalers.yaml) (`curl -O https://raw.githubusercontent.com/kici-dev/kici-public/main/examples/quickstart/compose/scalers.yaml`) and `docker compose restart orchestrator`.
- The spawned agent comes up but immediately disconnects with `connection refused`: spawned containers can't reach `host.docker.internal:4000`. On Docker Desktop (Mac/Windows) and Podman 4+ this should work out of the box; on plain Linux Docker engine the `extraHosts: ['host.docker.internal:host-gateway']` line in `scalers.yaml` adds the alias. If that's still failing, your firewall is dropping bridge-to-host traffic — `sudo iptables -L DOCKER-USER` and add a permissive rule, or temporarily set `network_mode: host` on the orchestrator service.

**Push happens but no run appears in the dashboard.** Either GitHub didn't deliver the webhook (check the App's "Recent deliveries" tab in GitHub's settings — look for 4xx responses), or the orchestrator received it but no workflow matched. Run `kici test push` against your workflow file to confirm a `push` to your branch would trigger something.

**Postgres won't start.** If you set a custom `POSTGRES_PASSWORD` after a previous boot, the data volume from the earlier attempt carries the old password and is incompatible. `docker compose down -v` wipes the volume and lets you start fresh.
