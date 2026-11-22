---
title: GitHub App provider
description: Connect KiCI to GitHub via a GitHub App — full Checks API, installation-token clones, and cross-org dispatch
---

The **GitHub App** is KiCI's flagship source. A single App:

1. receives `push`, `pull_request`, and related events from every repo it's installed on,
2. clones repos with a short-lived installation token (no deploy key to manage),
3. posts workflow / job / step Check runs back to the commit — visible on
   the commit view for a plain `push` and on the **Checks** tab of any pull
   request that contains it (see
   [GitHub checks architecture](../../architecture/webhooks/github-checks.md)).

You don't need an App for every scenario — if you only care about `push`
events, don't want to install an App, or are using a non-GitHub forge,
use the [universal-git provider](universal-git.md) instead.

## GitHub App vs. `github-repo` preset

Both paths reach the same trigger pipeline; they differ in what the
forge side looks like:

| Capability                               | GitHub App (this guide)                | `github-repo` preset on universal-git       |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------- |
| Webhook source                           | App-level webhook (one per App)        | Per-repo webhook (one per repo)             |
| Clone auth                               | Installation token (auto, short-lived) | PAT or SSH deploy key (you manage rotation) |
| Check runs on pull requests              | Yes — full KiCI Checks UI              | No (status post only via custom step)       |
| Cross-repo install in seconds            | Yes (install the App on more repos)    | No (new webhook per repo)                   |
| Works without a GitHub org admin         | No (App creation is org-scoped)        | Yes (per-repo webhook is repo-admin)        |
| Works on Forgejo / Gitea / Gogs / GitLab | No                                     | Yes (other presets)                         |

Use the App when you can; the `github-repo` preset is a fallback for
repos where you can't install an App.

## One-click setup (recommended)

`kici-admin source add github --manifest` creates **and** configures the
GitHub App for you via GitHub's App Manifest flow. KiCI builds a manifest
with the exact permissions, events, webhook URL, and webhook secret baked
in, so you never pick permissions, paste a URL, generate a secret, or
download a `.pem` by hand — the App is correct by construction.

```bash
kici-admin --url http://<orchestrator-host>:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN \
  source add github --manifest --name my-org --github-org my-org
```

`--github-org <slug>` creates the App under a GitHub **organization** (the
`<slug>` is the org's `github.com/<slug>` URL slug, not its display name) — the
recommended default, since org-owned Apps can be installed across the org. Drop
the flag only when you deliberately want a personal-account App, which can be
installed solely on repos you own. You need permission to create Apps in that
org (be an org owner, or have the org allow member App creation).

What happens:

1. The CLI resolves your org's webhook URL and opens GitHub with a
   pre-filled App manifest. You click **"Create GitHub App"** once — the
   only manual step.
2. GitHub redirects back to a localhost callback; the CLI exchanges the
   returned setup code for the App's id, private key, and webhook secret.
   **The private key is exchanged and stored only on your orchestrator
   host — it never transits the KiCI Platform.**
3. The CLI stores the credentials encrypted under `KICI_SECRET_KEY` and
   registers the routing key `github:<appId>`, reusing the same storage
   path as the manual flow.
4. It opens the App's install page so you can pick repos, then verifies
   end-to-end: it waits for the installation, mints an installation token,
   and confirms repo access before declaring success.

```
$ kici-admin source add github --manifest --name my-org --github-org my-org
→ Opening GitHub to create your App…
→ ✓ App created (id 12345), credentials captured
→ ✓ Stored on orchestrator (encrypted), registered as github:12345
→ Install the App on your repos: https://github.com/apps/my-org/installations/new
→ ✓ Installation detected (account my-org)
→ ✓ Credentials verified (3 repositories reachable)

GitHub App "my-org" is live.
  Webhook: https://<platform-host>/webhook/<orgId>/github
```

In `platform` and `hybrid` mode the baked webhook URL is the hosted Platform's
(`https://<platform-host>/webhook/<orgId>/github`). In `observed` and
`independent` mode it is the orchestrator's own
(`<KICI_WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github`; independent mode uses
`__default__` as the org segment). `--webhook-url` overrides it in every mode.

**Flags:**

| Flag                  | Effect                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`       | The App name you _request_ on GitHub (required). GitHub assigns the final name + slug; the stored, displayed name always comes from GitHub (see [Display name and slug](#display-name-and-slug)).                   |
| `--github-org <slug>` | Create the App under a GitHub organization instead of your personal account.                                                                                                                                        |
| `--webhook-url <url>` | **Advanced / self-hosted.** Bake this `https://` URL into the App's webhook verbatim instead of the URL the orchestrator resolves for its mode. See [Self-hosted webhook URL](#self-hosted-webhook-url-override).   |
| `--no-browser`        | Headless mode: the CLI prints a `kici.dev` URL to open, then reads the setup code you paste back. The page is pure client-side — it only displays the short-lived code, which is useless once the CLI exchanges it. |

**The org of the source.** On an orchestrator attached to the Platform, the
new source belongs to the org the orchestrator is attached to: the org that
`kici-admin orchestrator status`, `kici compile` and the dashboard show. Its
runs use that org's contexts, secrets and fork policy. `--org <orgId>` accepts
only that org; the CLI checks it before it creates the App. On an
`independent` orchestrator the source belongs to `__default__`. The command
prints the org on an `Org:` line. See
[Which org a source belongs to](../../operator/orchestrator/kici-admin/sources.md#which-org-a-source-belongs-to).

The manifest flow always creates a **new** App on GitHub. If a source for
that App id already exists on the orchestrator, the command refuses — use
`source update` to rotate an existing App's credentials.

If any step after App creation fails (e.g. storage), the CLI prints the
captured App id and writes the private key to a `0600` file, then tells
you how to finish with the manual `source add github` command — so a
created App is never orphaned.

An `independent` orchestrator receives App deliveries on its own direct
ingress. The manifest flow bakes
`<KICI_WEBHOOK_PUBLIC_URL>/webhook/__default__/github`, so set
`KICI_WEBHOOK_PUBLIC_URL` first. See
[Direct GitHub ingress](../../operator/orchestrator/github-ingress.md).

## Manual setup (fallback)

When you'd rather create the App by hand — or your environment can't run
the manifest flow — follow these steps.

### Create the GitHub App on GitHub's side

1. **Decide the App scope.** User-owned Apps can only be installed on
   repos you own; organization-owned Apps can be installed anywhere in
   the org. For production, create the App under the org.

2. **Create the App.** Go to _Settings -> Developer settings -> GitHub
   Apps -> New GitHub App_ (org-level is _Settings -> Developer
   settings -> GitHub Apps_ on the org page).

3. **Set the webhook URL.** The URL depends on the orchestrator's mode:
   - `platform` and `hybrid`: the hosted Platform endpoint, one per org.
     The Platform relays each delivery to your orchestrator over its
     outbound connection.

     ```
     https://<platform-host>/webhook/<orgId>/github
     ```

   - `observed` and `independent`: the orchestrator's own URL. Use the
     org-scoped URL for an App-level webhook, or the per-source URL
     `<KICI_WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github/<source-id>` for a
     classic repository webhook. An `independent` orchestrator uses
     `__default__` as the `<orgId>` segment.

     ```
     <KICI_WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github
     ```

   The `<orgId>` segment is the KiCI organization ID the source belongs to;
   the `<appId>` is discovered from `X-GitHub-Hook-Installation-Target-ID`
   at request time and is _not_ part of the URL.

4. **Set the webhook secret.** Generate a random hex string (e.g.
   `openssl rand -hex 32`) and save it for step 4 of the orchestrator
   registration below. GitHub uses this secret to HMAC-sign every
   webhook; KiCI rejects mismatches.

5. **Pick permissions.** Minimum required:

   | Scope                       | Access       | Why                                                                         |
   | --------------------------- | ------------ | --------------------------------------------------------------------------- |
   | Repository -> Contents      | Read         | Clone the repo to read the lock file                                        |
   | Repository -> Metadata      | Read (auto)  | Default for every App                                                       |
   | Repository -> Pull requests | Read         | Match `pull_request` triggers                                               |
   | Repository -> Checks        | Read & write | Post KiCI's enriched Check runs                                             |
   | Repository -> Issues        | Read         | Receive `issue_comment` events: `/kici approve` and `/kici reject` comments |

   These cover the whole flow: clone, trigger matching, Check runs, and
   pull-request comment commands.
   [CI trust](../../architecture/security/ci-security.md) needs no
   permission of its own — it reads the fork relationship straight out of
   the webhook payload and calls no GitHub API.

6. **Subscribe to events.** At minimum: `push`, `pull_request`,
   `check_run`, `check_suite`, and `issue_comment`. GitHub offers
   `issue_comment` only after you grant the Issues permission above. Add
   others (`issues`, `release`, ...) if your workflows use those triggers.

7. **Generate a private key.** Scroll to the bottom of the App settings
   and click _Generate a private key_. A `.pem` file downloads —
   store it safely; you cannot redownload it.

8. **Copy the App ID.** It's the numeric ID near the top of the App
   settings page. You'll need it for `--app-id` below.

9. **Install the App on target repos.** Under the App's _Install App_
   tab, install it on the repos (or whole org) that should trigger
   KiCI runs. Re-install to add repos later — this is live and
   revocable without redeploying the App.

### Register the App with the orchestrator

With the App ID, private key `.pem`, and webhook secret in hand:

```bash
kici-admin --url http://<orchestrator-host>:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN \
  source add github \
  --name my-org \
  --app-id 12345 \
  --private-key @/path/to/private-key.pem \
  --webhook-secret <the-webhook-secret-from-step-4>
```

The command prints the routing key (always `github:<appId>`) and the public
webhook URL to paste into the GitHub App's "Webhook URL" field:

```
Source added: github:<appId> (my-org)
Webhook URL:  https://<platform-host>/webhook/<orgId>/github
  ↳ Paste this into your GitHub App's "Webhook URL" field.
```

In `observed` and `independent` mode the URL is the orchestrator's own
per-source URL, `<KICI_WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github/<source-id>`.
When `KICI_WEBHOOK_PUBLIC_URL` is not set, the line reads
`(unavailable — KICI_WEBHOOK_PUBLIC_URL is not set on the orchestrator)` with a
hint to set it. `kici-admin source list` prints the URL again under each
GitHub source (`ingress: …`).

The private key and webhook secret are stored encrypted in the orchestrator database under
`KICI_SECRET_KEY`; no restart needed — the orchestrator accepts webhooks from
this App immediately.

**Secret input modes** (for `--private-key` and `--webhook-secret`):

| Mode                 | Syntax                  | Example                                                   |
| -------------------- | ----------------------- | --------------------------------------------------------- |
| Direct value         | `--private-key <value>` | `--webhook-secret mysecret`                               |
| File (`@` prefix)    | `--private-key @<path>` | `--private-key @/path/to/key.pem`                         |
| Environment variable | `--from-env <var>`      | `--from-env GITHUB_PRIVATE_KEY`                           |
| Standard input       | `--stdin`               | `cat key.pem \| kici-admin source add github --stdin ...` |

Use `@file` for private keys — it reads the full PEM including
newlines without quoting pitfalls.

To list and inspect:

```bash
kici-admin source list                             # All configured sources
kici-admin source get-webhook-secret github:12345  # Fetch the secret (for debugging)
```

For the full CLI reference see the `source` section of the
[kici-admin CLI reference](../../operator/orchestrator/kici-admin-cli.md).

## Routing keys

Every GitHub App source has routing key `github:<appId>`. It's the
identifier every other KiCI surface uses to talk about the source:

- `kici-admin source update github:<appId> ...` for rotation / updates
- `kici-admin source remove github:<appId>` to decommission
- `kici-admin org-settings global-workflows ... --org <orgId> [--source github:<appId>]` for policy (org-scoped row, optional per-entry source qualifier)
- The orchestrator's source records and event-log entries key on
  `github:<appId>`; org-level settings key on `customer_id` (one row
  per org)

If you install the same App across multiple KiCI orgs, each org has
its own source record and the orchestrator looks up the right one by
combining the URL's `<orgId>` with the App ID from the
`X-GitHub-Hook-Installation-Target-ID` header.

## Display name and slug

For a GitHub App source, **GitHub is the source of truth for the displayed
name**. `--name` is only the name you _request_ when the App is created;
GitHub assigns the final display name and a URL-safe **slug**
(`my-org` → `my-org-1` if the name was taken). KiCI captures both at creation
and shows them in the dashboard **Sources** tab — the display name prominently,
with the slug as dimmed secondary text.

If you later rename the App in GitHub's UI, KiCI keeps the displayed name in
sync two ways:

- **Automatically**, on a daily schedule. The orchestrator re-reads each GitHub
  source's name + slug from GitHub and updates the dashboard if they changed.
  The interval is configurable via `KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS`
  (default 24h).
- **On demand**, with `source refresh`:

  ```bash
  kici-admin source refresh github:<appId>   # one source
  kici-admin source refresh --all            # every GitHub source
  ```

  It prints `old → new` for any name or slug that changed, and is a no-op when
  GitHub already matches what KiCI has stored. Non-GitHub routing keys are
  rejected — name/slug sync applies only to GitHub App sources.

`source refresh` also compares the App with what KiCI needs. It warns when the
App lacks a permission or an event (for example the Issues permission or the
Issue comment event), and lists the installations that have not accepted a new
permission yet. `--json` carries the same findings as `missingEvents`,
`missingPermissions` and `installationsPendingApproval`. The daily refresh
logs a warning for each App with a gap.

## Self-hosted webhook URL override

By default the manifest flow bakes the URL the orchestrator resolves for its
mode (see [One-click setup](#one-click-setup-recommended)). If you run
your own ingress and want GitHub to deliver events to it instead, pass
`--webhook-url` when creating the App:

```bash
kici-admin source add github --manifest --name my-org \
  --webhook-url https://hooks.my-infra.example/github
```

The supplied URL must be an absolute `https://` URL; it is written into the
App's webhook configuration **verbatim**. This is the operator asserting "I own
webhook delivery": KiCI adds **no** ingress at this URL and does **not** receive
events there — your own infrastructure is responsible for accepting GitHub's
deliveries and routing them onward.

## GitHub Enterprise Server

A GitHub App can live on a GitHub Enterprise Server instead of github.com. Give
the server's web URL with `--github-url` when you add the source. The
orchestrator stores the server with the source and sends every call for that
App to it. The routing key stays `github:<appId>`, and runs, check runs and
clones work as they do on github.com. The dashboard links the
commits, branches, pull requests and workflow files of these runs to the server,
not to github.com.

### Add an App on the server

The one-click setup creates the App on the server:

```bash
kici-admin --url http://<orchestrator-host>:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN \
  source add github --manifest --name my-org --github-org my-org \
  --github-url https://ghe.example.com
```

The browser opens the server's App creation page,
`https://ghe.example.com/organizations/my-org/settings/apps/new` (or
`https://ghe.example.com/settings/apps/new` without `--github-org`). With
`--no-browser`, the page you open names the server (`Create the App on
ghe.example.com`), and it sends the manifest only when you click **Continue**.
kici-admin then exchanges the setup code at the server's API, stores the
server with the source, and prints the server's install page:

```
→ Install the App on your repos: https://ghe.example.com/github-apps/my-org/installations/new
```

kici-admin itself connects to the server in this flow. Run it on a host that
reaches the server and trusts its certificate (see
[Trust a private CA](#trust-a-private-ca)).

For an App that you created on the server by hand, add `--github-url` to the
manual command:

```bash
kici-admin --url http://<orchestrator-host>:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN \
  source add github --name my-org --app-id 12 \
  --private-key @/path/to/private-key.pem \
  --webhook-secret <secret> \
  --github-url https://ghe.example.com
```

The orchestrator checks the App at the server before it stores the source.
Without `--github-url`, it checks the App at api.github.com, and the command
fails with `GitHub API validation failed`.

`--github-url` takes the server's `https://` web URL, with no path. A port is
kept, and one trailing slash is removed. The value can have at most 128
characters. kici-admin refuses `api.github.com` and `www.github.com` with a
hint (use `https://github.com`), and refuses a GHE.com host (see
[Limits](#limits)).

`kici-admin source list` prints the server under the source:

```
GitHub sources:
  github:12            my-org                         (github)  org: <orgId>
    server: https://ghe.example.com
```

With `--json`, the source's `githubUrl` holds the server. A github.com source
has no `server:` line and no `githubUrl`. The orchestrator stores the server
apart from the source's `config`. It ignores a `githubUrl` key in the
`config`, and `source list` does not show one.

To move a source to another server, run
`kici-admin source update github:<appId> --github-url <url>`. The orchestrator
checks the App at the new server first, and keeps the old server when that
check fails. `--github-url https://github.com` moves the source back to
github.com. A token scoped to the source with `--routing-key` cannot change the
server: the command is refused with `403`.

The orchestrator does not load a source whose stored server is not an
`https://` GitHub web URL. It logs an error that names the routing key, and
refuses the source's App credentials. The dashboard shows the source's
registered workflows with no link. To repair the source, run
`kici-admin source update github:<appId> --github-url <url>`.

### What connects to the server

- **The orchestrator** calls the server's REST API at `<url>/api/v3`. It
  checks the App, mints installation tokens, reads the lock file, and creates
  and updates check runs. `source refresh` and `source redeliver` read the App,
  its installations and its webhook deliveries there. A token that a workflow
  mints from its own GitHub App credential
  (`ctx.kici.git.github.getToken`) comes from the server of the run's source.
- **Agents** clone over HTTPS from `<url>/<owner>/<repo>.git`, with an
  installation token.
- **Your browser** opens the App creation page and the install page,
  `<url>/github-apps/<slug>/installations/new`.

### Webhook delivery

The server must reach the webhook URL of the App:

- In `platform` and `hybrid` mode, the server sends events to the hosted
  Platform, `https://<platform-host>/webhook/<orgId>/github`. Let the server
  connect out to that host over HTTPS.
- In `observed` and `independent` mode, the server sends events to the
  orchestrator's own ingress, `<KICI_WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github`.
  See [Direct GitHub ingress](../../operator/orchestrator/github-ingress.md).

### Trust a private CA

When a private CA signs the server's certificate, make each component that
connects to the server trust that CA.

**The orchestrator** and **kici-admin**: set `NODE_EXTRA_CA_CERTS` to the path
of the CA's PEM file. Node.js adds it to its built-in roots. Node.js reads the
variable only when the process starts, so restart the orchestrator after you
set it. An installed orchestrator reads its environment from its env file,
`<config-dir>/<service-name>.env` (`kici-admin orchestrator status` prints the
path).

**Agents** clone with git, which reads `GIT_SSL_CAINFO`. That variable
**replaces** git's CA bundle; it does not add to it. Point it at a bundle that
holds the public roots and your private CA, or clones from github.com and other
public hosts fail. For example, on a Debian or Ubuntu host:

```bash
cat /etc/ssl/certs/ca-certificates.crt ghe-ca.pem > /etc/kici/ca-bundle.pem
```

Set the variable in the scaler label set's `env`, and mount the bundle into
container agents read-only:

```yaml
scalers:
  - name: container-default
    type: container
    labelSets:
      - labels: [linux, container]
        image: quay.io/kici-dev/kici-agent:<version>
        env:
          GIT_SSL_CAINFO: /etc/kici/ca-bundle.pem
        volumes:
          - /etc/kici/ca-bundle.pem:/etc/kici/ca-bundle.pem:ro
```

A bare-metal agent reads the file from its host, so it needs only the `env`
entry. The bare-metal scaler also gives each agent it starts the TLS trust
settings set on the orchestrator.

Jobs receive the TLS trust settings that the agent has: `GIT_SSL_CAINFO`,
`GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS`. A
step that clones from the server therefore trusts the same CA. For steps that
call the server with Node.js, also add `NODE_EXTRA_CA_CERTS` to the label
set's `env`.

These settings are paths on the agent host. A job that runs in its own image
(`container:`) gets them in one of two ways:

- **On the container scaler**, the job's image runs as the agent. It receives
  the label set's `env` and `volumes` as given. Mount the bundle through
  `volumes` at the path that `env` names, as in the example above.
- **On an agent that starts the job in a container of its own**, such as a
  bare-metal agent, the agent mounts each file or directory read-only under
  `/run/kici/trust/` and points the setting at that mount. The image keeps its
  own CA store, such as `/etc/ssl/certs`. Each path must be a regular file on
  the agent host, or a directory for `SSL_CERT_DIR` and `GIT_SSL_CAPATH`.
  Otherwise the job does not receive the setting, and the image's own CA
  bundle stays in use.

A job that sets one of these variables in its own `env` keeps its value, and
the agent mounts nothing for it.

**Network policy**: container and Firecracker agents cannot reach private
address ranges by default. When the server has a private address, add its range
to the label set's `networkPolicy.allowlist`. See
[Network policy](../../operator/orchestrator/auto-scaler/common-config.md#network-policy).

### Approvals from server users

User ids are numbered per server, so KiCI keeps the users of each server in a
separate identity namespace, `github:<host>` (for example
`github:ghe.example.com`). A user of the server never matches an identity that
is linked on github.com, even when the numeric ids are equal. A `/kici approve`
or `/kici reject` comment from a server user therefore does not act on a hold
through a github.com identity.

Release or reject the hold from the dashboard, or with `kici approve` /
`kici reject`. On an `independent` orchestrator, which keeps its own approval
directory, you can register a server user as an approver:

```bash
kici-admin trust-policy directory-set --org __default__ --user-id <kici-user-id> \
  --provider github:ghe.example.com \
  --provider-username <login> --provider-user-id <numeric-user-id> \
  --ci-trust write
```

`--provider` is `github:` followed by the server's host, with its port when
the URL names one. Comments from that user then act on holds like a linked
github.com user's comments do.

### Limits

- **One source per App id.** An orchestrator holds one source for each numeric
  App id, whatever server the App lives on. App ids are numbered per server, so
  an App on the server can have the same id as an App on github.com. Two such
  Apps cannot both be sources in one organization: put the second one on
  another orchestrator, in another organization.
- **GHE.com is not supported.** kici-admin refuses a `*.ghe.com` URL, because
  GHE.com does not serve its API at `<url>/api/v3`.
- **`--github-url` length.** The URL can have at most 128 characters.

## Global workflows

A GitHub App source opts in to org-wide global workflows using the
org-scoped settings row. Pass `--org <orgId>`
to select the row; on `*-add` mutators, pass `--source github:<appId>`
when you want a list entry pinned to this specific App rather than
applying to any source in the org:

```bash
# Enable global workflows cluster-wide (the master switch is fleet-wide, held by the operator)
kici-admin cluster-settings set --global-workflows-enabled true

# Allow the listed repo as an author for any source in the org
kici-admin org-settings global-workflows allow-add 'my-org/ci-workflows/*' \
  --org <orgId>

# Allow the listed repo as an author only when authored on this App
kici-admin org-settings global-workflows allow-add 'my-org/ci-workflows/*' \
  --org <orgId> --source github:12345

# Deny events from untrusted repos delivered on this App
kici-admin org-settings global-workflows deny-add 'my-org/contrib/*' \
  --org <orgId> --source github:12345
```

Global workflows authored in a GitHub App repo can dispatch against
events from universal-git sources in the same org, and vice versa,
with each clone using its own source's credentials. See
[Global workflows](../../architecture/global-workflows.md) for the
policy model and cross-source dispatch contract.

## Check runs

Once registered, the App's Check-runs permission lets KiCI post
enriched Check runs:

- `kici/{workflowName}` — overall pass/fail for the workflow
- `kici/{workflowName}/job/{jobName}` — per-job detail with step progress
- `kici/{workflowName}/setup` — (optional) build / dependency-install check

Step progress, log tails, and source-location annotations are all
driven by the orchestrator's reporting module; no workflow
configuration is required beyond installing the App with the
`checks: write` permission.

Each check run's conclusion follows the job's or workflow's status:

| Status                                  | Check conclusion |
| --------------------------------------- | ---------------- |
| `success`                               | `success`        |
| `failed`, `drift_dropped`, `unroutable` | `failure`        |
| `cancelled`                             | `cancelled`      |
| `timed_out_stale`                       | `timed_out`      |
| `skipped`                               | `skipped`        |

GitHub accepts a `skipped` check as a passed required check. A job that a rule skipped, or that a `needs` edge skipped, therefore does not block a pull request. To block a pull request when any job of a workflow fails, make the workflow check `kici/{workflowName}` required, not only the per-job checks.

Check runs are keyed to the head commit SHA, so they surface whether or
not a pull request exists: after a `push` you see the pass/fail directly
on the commit (a red ✗ / green ✓ next to the SHA in GitHub's commit list
and on the commit page), and the same checks roll up into the **Checks**
tab of any pull request that later includes the commit. A failing run is
therefore visible in GitHub itself without opening the KiCI dashboard.

The **Details** link of each check run opens the run in the KiCI dashboard.
The workflow, setup and job checks of one run all open the same run page. An
orchestrator connected to the KiCI Platform gets the dashboard address from the
Platform, so it needs no configuration. To send reviewers to a different
address, set `KICI_DASHBOARD_URL` on the orchestrator (see the
[orchestrator configuration reference](../../operator/orchestrator/configuration.md)).
An orchestrator in `independent` mode posts check runs without a Details link.

For architecture details see
[GitHub checks architecture](../../architecture/webhooks/github-checks.md).

## Pull-request comment commands

A `/kici approve` or `/kici reject` comment on a pull request releases or
rejects a security hold (see
[CI security](../../architecture/security/ci-security.md#approval-channels)).
GitHub sends each comment to KiCI as an `issue_comment` event. An App can
subscribe to that event only when it has read access to the **Issues**
repository permission. The one-click setup requests both. A workflow with a
[`comment()`](../sdk/triggers.md#comment) trigger needs the same subscription.

### Enable comment commands on an existing App

Open the App's _Settings -> Developer settings -> GitHub Apps -> (your App)
-> Edit -> Permissions & events_. For an org-owned App, start from the org's
_Settings_ page. If **Repository permissions -> Issues** is set to _No
access_, or **Subscribe to events -> Issue comment** is clear, the App sends
no comments to KiCI. To fix this:

1. Set **Repository permissions -> Issues** to **Read-only**.
2. Under **Subscribe to events**, select **Issue comment**.
3. Click **Save changes**.
4. Accept the new permission on every installation. GitHub emails the
   owner of each account where the App is installed, and the installation's
   _Configure_ page shows a request to review the new permissions. GitHub
   does not apply the permission to an installation until its owner accepts
   it, so the repos of that installation send no comments until then.
5. Run `kici-admin source refresh github:<appId>`. It warns while the App
   still lacks the Issues permission or the Issue comment event, and lists
   each installation that has not accepted the permission yet.

The orchestrator needs no change: it already handles `issue_comment`
deliveries. To confirm, post a comment on a pull request in an installed repo
and look for an `issue_comment` delivery under the App's _Advanced -> Recent
Deliveries_.

## Rotation

### Rotate the webhook secret

1. Generate a new random hex: `openssl rand -hex 32`.
2. Update GitHub: _App settings -> Webhook -> Webhook secret_. GitHub
   will sign new deliveries with this immediately.
3. Update the orchestrator:

   ```bash
   kici-admin source update github:12345 --webhook-secret <new-secret>
   ```

   The orchestrator verifies signatures against every cached secret
   during a dual-secret window, so brief mismatches during rotation
   don't drop deliveries. The HMAC verifier iterates over all stored
   secrets for the routing key.

### Rotate the private key

1. In GitHub's App settings click _Generate a private key_ — this
   does **not** revoke existing keys. Download the new `.pem`.
2. Push it to the orchestrator:

   ```bash
   kici-admin source update github:12345 --private-key @/path/to/new-key.pem
   ```

3. After confirming clones work on the new key, delete the old key
   from GitHub's App settings.

### Decommission

```bash
kici-admin source remove github:12345
```

After removal the routing-key row and its secrets are purged; GitHub
deliveries to the endpoint will be rejected as "Unknown routing key".
Uninstall the App from GitHub's side separately.

## Troubleshooting

**Webhook hits the endpoint but KiCI replies 404 `Unknown
organization`.** The `<orgId>` segment of the webhook URL doesn't
match the org that owns the source. Check the URL registered in
_App settings -> Webhook_ against `kici-admin source list`.

**Webhook hits the endpoint but KiCI replies 401 `Invalid
signature`.** The webhook secret in the App settings doesn't match
the one stored with the source. Rotate it via the steps above.

**Webhook hits the endpoint but KiCI replies 400 `Missing GitHub App
target headers`.** The request isn't actually from a GitHub App
(missing `X-GitHub-Hook-Installation-Target-Type: integration` +
`X-GitHub-Hook-Installation-Target-ID`). If you're test-firing a
webhook, use the App's _Recent Deliveries_ tab on GitHub to re-send a
real one.

**GitHub's _Recent Deliveries_ show 409 `OBSERVE_ONLY_SOURCE`.** The App
still points at the hosted Platform, but the orchestrator that serves the
source runs in `observed` mode and takes deliveries only on its own URL. Set
the App's webhook URL to the URL `kici-admin source list` prints. See
[An App still pointed at the hosted Platform](../../operator/orchestrator/github-ingress.md#an-app-still-pointed-at-the-hosted-platform).

**Webhook arrives but no run fires.** The orchestrator accepted the
webhook but no workflow registration matched. Causes (in order of
likelihood): the repo isn't registered with the orchestrator yet
(push a commit that touches `.kici/kici.lock.json` first), the event
type isn't one the workflow's triggers list, or
`global_workflow_denied_repos` filtered out the source repo. Check
`kici-admin event-log list --routing-key github:12345` and the
orchestrator logs for `no registrations for event`.

**Clone fails with 401 / 403.** The installation token minted from
the App private key was refused. Usually means the App was uninstalled
from the repo, or the private key on the orchestrator no longer matches
the one GitHub knows about (rotate it).

**Check runs don't appear on pull requests.** The App is missing the
`checks: write` permission or wasn't installed on the target repo.
Re-request permissions in _App settings -> Permissions & events_
(GitHub will prompt installers to accept the new scope on next visit)
and confirm the App is installed on that repo.

**A `/kici approve` comment has no effect.** Look under the App's
_Advanced -> Recent Deliveries_ for an `issue_comment` delivery. If there is
none, the App does not have the Issues permission or the Issue comment
subscription, or the installation has not accepted the permission yet. See
[Enable comment commands on an existing App](#enable-comment-commands-on-an-existing-app).
If the delivery is there, the commenter needs a linked GitHub identity and
`ci_trust:write` (see
[Identity linking](../../operator/security/security.md#identity-linking)). A
comment acts only on security holds; release a reviewer hold from the
dashboard or with `kici approve`. A comment from a GitHub Enterprise Server
user is matched only in that server's identity namespace; see
[Approvals from server users](#approvals-from-server-users).

## See also

- [Universal-git provider](universal-git.md) — for Forgejo / Gitea /
  Gogs / GitLab, and for plain-GitHub repos without an App
- [GitHub checks architecture](../../architecture/webhooks/github-checks.md)
- [Global workflows](../../architecture/global-workflows.md)
- [kici-admin CLI reference](../../operator/orchestrator/kici-admin-cli.md)
- [Event routing](../../operator/event-routing.md) — operator-level
  routing-key mechanics
