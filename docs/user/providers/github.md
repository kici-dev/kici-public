---
title: GitHub App provider
description: Connect KiCI to GitHub via a GitHub App — full Checks API, installation-token clones, and cross-org dispatch
---

The **GitHub App** is KiCI's flagship source. A single App:

1. receives `push`, `pull_request`, and related events from every repo it's installed on,
2. clones repos with a short-lived installation token (no deploy key to manage),
3. posts workflow / job / step Check runs back to the pull request (see
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

**Flags:**

| Flag                  | Effect                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`       | The App name you _request_ on GitHub (required). GitHub assigns the final name + slug; the stored, displayed name always comes from GitHub (see [Display name and slug](#display-name-and-slug)).                                                                                     |
| `--github-org <slug>` | Create the App under a GitHub organization instead of your personal account.                                                                                                                                                                                                          |
| `--webhook-url <url>` | **Advanced / self-hosted.** Bake this `https://` URL into the App's webhook verbatim and skip the platform-mode webhook-URL resolution (so it works even where the auto-resolved KiCI Platform URL is unavailable). See [Self-hosted webhook URL](#self-hosted-webhook-url-override). |
| `--no-browser`        | Headless mode: the CLI prints a `kici.dev` URL to open, then reads the setup code you paste back. The page is pure client-side — it only displays the short-lived code, which is useless once the CLI exchanges it.                                                                   |

The manifest flow always creates a **new** App on GitHub. If a source for
that App id already exists on the orchestrator, the command refuses — use
`source update` to rotate an existing App's credentials.

If any step after App creation fails (e.g. storage), the CLI prints the
captured App id and writes the private key to a `0600` file, then tells
you how to finish with the manual `source add github` command — so a
created App is never orphaned.

Independent-mode orchestrators have no GitHub-App ingress (it is
Platform-relayed), so the manifest flow is unavailable there; use a
generic webhook source instead.

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

3. **Set the webhook URL.** KiCI exposes one webhook endpoint per org:

   ```
   https://<platform-host>/webhook/<orgId>/github
   ```

   GitHub App webhooks are always delivered to this Platform endpoint and
   relayed to your orchestrator over its outbound connection — platform and
   hybrid orchestrators both receive GitHub events this way. Independent-mode
   orchestrators have no Platform connection and therefore no GitHub-App
   ingress; use a generic webhook source instead. The `<orgId>` segment is
   the KiCI organization ID the source belongs to; the `<appId>` is
   discovered from `X-GitHub-Hook-Installation-Target-ID` at request time and
   is _not_ part of the URL.

4. **Set the webhook secret.** Generate a random hex string (e.g.
   `openssl rand -hex 32`) and save it for step 4 of the orchestrator
   registration below. GitHub uses this secret to HMAC-sign every
   webhook; KiCI rejects mismatches.

5. **Pick permissions.** Minimum required:

   | Scope                       | Access       | Why                                                                                                                                                       |
   | --------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Repository -> Contents      | Read         | Clone the repo to read the lock file                                                                                                                      |
   | Repository -> Metadata      | Read (auto)  | Default for every App; also lets KiCI look up a pull-request author's repository access level for CI trust                                                |
   | Repository -> Pull requests | Read         | Match `pull_request` triggers                                                                                                                             |
   | Repository -> Checks        | Read & write | Post KiCI's enriched Check runs                                                                                                                           |
   | Organization -> Members     | Read         | (optional, org installs) Receive `organization` / `membership` / `team` events so KiCI's CI-trust permission cache invalidates promptly on access changes |

   The first four rows cover the core flow (clone, trigger matching,
   Check runs). The **Organization -> Members** row is only relevant if
   you use [CI trust tiers](../../architecture/security/ci-security.md)
   on an org-level install — see the event note below.

6. **Subscribe to events.** At minimum: `push`, `pull_request`,
   `check_run`, `check_suite`. Add others (`issues`, `release`, ...) if
   your workflows use those triggers.

   **For CI trust (optional but recommended on org installs):** also
   subscribe to `member`, `organization`, `membership`, and `team`.
   KiCI caches each pull-request author's repository access level (used
   to decide whether workflow changes take effect immediately or are
   held for approval — see
   [CI security](../../architecture/security/ci-security.md)). These
   events let the orchestrator drop stale cache entries the moment a
   contributor's access changes. They are not required for correctness:
   without them the cache simply ages out on its own 15-minute TTL, so a
   permission change can take up to 15 minutes to take effect. The
   `organization` / `membership` / `team` events require the
   **Organization -> Members** read permission and an org-level
   installation; `member` is a repository event covered by the default
   Metadata permission.

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

When the orchestrator runs in independent mode (no Platform connection) the
URL line reads `(unavailable — this orchestrator runs in independent mode)`,
because GitHub-App ingress is Platform-relayed. The private key and webhook
secret are stored encrypted in the orchestrator database under
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
- `kici-admin org-settings global-workflows ... --customer-id <orgId> [--source github:<appId>]` for policy (org-scoped row, optional per-entry source qualifier)
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

## Self-hosted webhook URL override

By default the manifest flow bakes the KiCI Platform webhook endpoint
(`https://<platform-host>/webhook/<orgId>/github`) into the App. If you run
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
deliveries and routing them onward. Supplying the flag also decouples App
creation from platform-mode URL resolution, so it works even in a configuration
where the auto-resolved KiCI Platform URL is unavailable.

## Global workflows

A GitHub App source opts in to org-wide global workflows using the
org-scoped settings row. Pass `--customer-id <orgId>` (alias `--org`)
to select the row; on `*-add` mutators, pass `--source github:<appId>`
when you want a list entry pinned to this specific App rather than
applying to any source in the org:

```bash
# Enable global workflows for the org
kici-admin org-settings global-workflows set-enabled true \
  --customer-id <orgId>

# Allow the listed repo as an author for any source in the org
kici-admin org-settings global-workflows allow-add 'my-org/ci-workflows/*' \
  --customer-id <orgId>

# Allow the listed repo as an author only when authored on this App
kici-admin org-settings global-workflows allow-add 'my-org/ci-workflows/*' \
  --customer-id <orgId> --source github:12345

# Deny events from untrusted repos delivered on this App
kici-admin org-settings global-workflows deny-add 'my-org/contrib/*' \
  --customer-id <orgId> --source github:12345
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

For architecture details see
[GitHub checks architecture](../../architecture/webhooks/github-checks.md).

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

## See also

- [Universal-git provider](universal-git.md) — for Forgejo / Gitea /
  Gogs / GitLab, and for plain-GitHub repos without an App
- [GitHub checks architecture](../../architecture/webhooks/github-checks.md)
- [Global workflows](../../architecture/global-workflows.md)
- [kici-admin CLI reference](../../operator/orchestrator/kici-admin-cli.md)
- [Event routing](../../operator/event-routing.md) — operator-level
  routing-key mechanics
