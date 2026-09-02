---
title: 'kici: notifications & diagnostics'
description: 'Notification channels, attestation verification, and diagnostics'
---

## Guide

### kici notifications

Manage your organization's notification configuration — channels, subscriptions, and the Slack-identity roster — programmatically, under your PAT against the hosted Platform's org-scoped API. Requires a PAT (run `kici login` first) and an active org (`kici org use <name>`, or pass `--org <id>` to any subcommand). These are the same operations the dashboard Notifications tab performs.

Every `list` supports `--json` for machine-readable output.

#### kici notifications channels

Manage the destinations a notification is delivered to (Slack or email).

```bash
# List channels
kici notifications channels list
kici notifications channels list --json

# Add a Slack channel
kici notifications channels add --type slack --name "alerts" \
  --connection <connectionId> --slack-channel <slackChannelId>

# Add an email channel
kici notifications channels add --type email --name "email" \
  --from-name "KiCI CI" --reply-to ci@example.com

# Remove a channel
kici notifications channels remove <channelId>
```

#### kici notifications subscriptions

Manage which runs notify which channel, with optional literal `--mentions` and digest accumulation.

```bash
# List subscriptions
kici notifications subscriptions list

# Notify a channel on any failure across the org
kici notifications subscriptions add --channel <channelId> --on-status failed

# Scope to a repo, mention people, and accumulate a digest over 30s
kici notifications subscriptions add --channel <channelId> \
  --on-status failed --repo-glob 'my-org/*' \
  --mentions U012ABCDEF,U345GHIJKL --accumulate-for 30000

# Remove a subscription
kici notifications subscriptions remove <subscriptionId>
```

Key options for `add`: `--level <run|job>` (default `run`), `--scope <org|team|user|actor>` (default `org`; `--scope-id` is required for `team`/`user`), `--on-status <csv>` (required), `--repo-glob` / `--workflow-glob` / `--job-glob`, `--mentions <csv>`, `--recipient-override <csv>`, `--on-failure-class <csv>`, `--accumulate-for <ms>`.

#### kici notifications roster

Manage the Slack-identity roster used for best-effort actor tagging — mapping the person who triggered a run to a Slack member id.

`roster add` requires the `notifications:admin` permission — it is the admin editor for the shared roster. To connect **your own** Slack account (no admin needed), use **Connect Slack** on the dashboard's personal Notifications tab, which runs Sign in with Slack; there is no CLI equivalent because the flow is browser-based.

```bash
# List roster entries
kici notifications roster list

# Admin: map a contributor to their Slack member id (by id, email, or @handle)
kici notifications roster add --connection <connectionId> \
  --subject-kind git_login --subject octocat \
  --input-form email --value octocat@example.com

# Remove a roster entry (admins; or your own connected entry)
kici notifications roster remove <entryId>
```

### kici verify-attestation

Verify a KiCI build-provenance attestation bundle offline. A bundle is the signed package a workflow step produces via `ctx.attestProvenance(...)`: a DSSE-wrapped SLSA in-toto statement, the ephemeral public key that signed it, and the KiCI identity token that anchors the build context. For the end-to-end attest → verify → view journey, see the [build provenance guide](../provenance.md). Verification establishes the full chain — the identity token verifies against the trusted issuer's JWKS, the DSSE signature verifies against the bundled key, and the statement's build context must match the token's claims (a mismatch is a hard failure). When an `[artifact]` is given, its SHA-256 digest is also matched against the attestation subject.

On success the output prints the **origin org** (the customer's public org id — the authoritative "who built this" the platform vouches for) and a **source marker**. A `kici run remote` attestation is flagged unmistakably: its `repository`/`ref`/`sha` are caller-supplied from a local working-tree overlay, not a triggered VCS commit, so a verifier must treat those coordinates as org-asserted rather than VCS-verified. A normal triggered run carries the ordinary `triggered` source marker. See the [build provenance guide](../provenance.md) for the full trust model.

```bash
kici verify-attestation [artifact] --bundle <path-or-url> [--trust-root <url-or-file>] [options]
```

**Trust root:** `--trust-root` defaults to your **configured orchestrator** — the orchestrator you `kici login` against, which owns the provenance signing key and publishes its own JWKS (see [Which trust root do I use?](../provenance.md#which-trust-root-do-i-use)), so the common case needs no flag. When no orchestrator is configured, the default falls back to the hosted KiCI platform's provenance issuer so historical platform-signed bundles still verify. The verifier never trusts the issuer named inside the token; supplying it out-of-band is what prevents a forged bundle from self-attesting. To override the default, pass `--trust-root` in one of two forms:

- **Online — an HTTPS issuer URL.** The verifier fetches `<url>/.well-known/openid-configuration`, reads its `issuer` and `jwks_uri`, and fetches the JWKS. The token's `iss` is pinned to the discovery document's `issuer`.
- **Offline — a self-contained trust-root file.** A local JSON file with the issuer and JWKS inlined, so no network access is needed (air-gapped verification):

  ```json
  {
    "issuer": "https://platform.example/issuer",
    "jwks": {
      "keys": [
        { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "alg": "ES256", "kid": "..." }
      ]
    }
  }
  ```

**Examples:**

```bash
# Default: verify against your configured orchestrator (no --trust-root needed)
kici verify-attestation ./dist/app.tgz --bundle ./app.tgz.kici.json

# Override: verify a bundle against a specific issuer, digest-checking the artifact
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root https://platform.example/issuer

# Offline / air-gapped: verify against a self-contained trust-root file
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root ./kici-trust-root.json

# Machine-readable result for scripting
kici verify-attestation --bundle ./app.tgz.kici.json \
  --trust-root https://platform.example/issuer --json
```

**Attestation origin marker.** On a PASS, the command surfaces when the identity
token was minted relative to the build. A normal attestation prints no marker
(the token was minted live). A **deferred** attestation prints an `ATTESTATION:
deferred` line — the build facts were sealed at build time and the token was
minted later, after a transient platform outage, bound to the frozen statement
by its hash. An **offline-backfill** attestation prints an `ATTESTATION:
offline-backfill` line — the run was ingested while the platform was down, so its
run/job rows were backfilled before the token was minted. Both still verify
(PASS); the marker discloses the temporal gap, and the organization id remains
the authoritative anchor.

**Exit codes:**

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | Verified — signature, identity, build context (and digest, if checked) all pass           |
| 1    | Not verified, or an error (missing `--bundle`, unreadable bundle, unreachable trust root) |

### kici diagnostics

Show the orchestrators, scalers, and agents serving your organization — the
terminal equivalent of the dashboard Infrastructure page. Reads the same
org-scoped data the dashboard does, so it needs `kici login` and an active org
(`kici org use <name>`).

The output has three parts: a one-line header (runs in the last 24h, success
rate, average duration, queued/running job counts), any infrastructure alerts
(only shown when present), and a tree of each orchestrator with its scalers and
agents. Each agent line shows its labels, platform/architecture, active/maximum
concurrency, and heartbeat age.

Alert lines are colored by severity — yellow for `warning`, red for `critical`.
A severity this build does not recognize is colored red, so an alert from a
newer Platform is never shown as less urgent than it might be.

```bash
kici diagnostics [options]
```

**Examples:**

```bash
# Show the full infrastructure tree
kici diagnostics

# Extended per-agent detail
kici diagnostics --verbose

# Only one orchestrator's scalers and agents
kici diagnostics --orchestrator conn-abc123

# Machine-readable output
kici diagnostics --json
```

### kici doctor

Walk your KiCI setup end to end and print the exact next command for each
problem found. Where `kici diagnostics` shows the org's infrastructure, `kici
doctor` checks **your own setup**: it runs six checks in onboarding order —
login (stored, unexpired credentials), active organization, a present, fresh,
and committed lock file, a live token probe against the platform, a connected
orchestrator for the org, and whether every workflow's `runsOn` labels are
satisfiable by a connected agent or scaler. Each check reports pass/warn/fail
with the fix command (e.g. `kici login`, `kici org use <name>`,
`kici compile`), so the first failing row tells you exactly what to run next.

```bash
kici doctor [options]
```

**Examples:**

```bash
# Diagnose the full setup
kici doctor

# Machine-readable result for scripting
kici doctor --json
```

The command exits `0` when every check passes, `1` when any check warns, and
`2` when any check fails, so it also works as a CI preflight.

### kici report

Gather a diagnostic bundle to share when you report a problem. `kici doctor`
tells you what is wrong; `kici report` packages the context somebody else needs
to see it. The bundle holds your CLI, Node and orchestrator versions, your
redacted configuration, and your project's workflow and lock-file state. With
`--run` it also holds the failing run's detail and logs.

```bash
kici report [options]
```

The command writes a ZIP and prints its path and `sha256`. It does not send
anything. Open the file and read it before you share it.

```bash
# Bundle your setup
kici report

# Scope it to the run that failed, and say what went wrong
kici report --run 8f3c1d2e --message "matrix job hangs on macOS"

# Choose the output path and attach your own metadata
kici report -o /tmp/bug.zip --metadata ticket=1234 --metadata severity=high
```

**Redaction.** KiCI removes known secret shapes — API keys, tokens, `Authorization`
headers, private keys, passwords in connection URLs — from configuration and
from log text. This is best effort. A secret in a format KiCI does not
recognize can survive, so review the bundle before you share it. `--no-redact`
turns redaction off and prints a warning; use it only on a bundle you keep.

**Sending it privately.** Add `--upload` to send the bundle to KiCI over a
one-time upload link. The bundle goes straight to KiCI storage, and the command
prints a reference id to quote:

```bash
kici report --run 8f3c1d2e --upload --message "matrix job hangs on macOS"
```

Uploads are private, are kept for 90 days, and are yours to withdraw:

```bash
# See what you have sent
kici report list

# Delete an uploaded bundle
kici report withdraw <ref>
```

Anyone in your organization can upload a report. By default you see and
withdraw your own; a member with the `support:admin` permission can manage
every report in the organization.

### kici feedback

`kici report` sends a problem with **your own runs** to KiCI privately. `kici
feedback` covers the other case: a defect in KiCI itself that reproduces
without your data, such as a documented flag that does not exist.

```bash
kici feedback
```

It prints what qualifies as a reportable discrepancy, what a report must
carry, what must never appear in a public issue, and where to file it. The
command reaches no network and files nothing.

```bash
# Open the prefilled issue form in your browser
kici feedback --open

# Read the same contract as structured data
kici feedback --json
```

`--json` exists for coding agents: KiCI is built to be driven by an LLM, and
an agent can read the rules without parsing prose. One of those rules is that
an agent drafts a report and a **person** decides to file it.

The full guide is [Reporting a discrepancy](../reporting-discrepancies.md).
A suspected vulnerability never goes in a public issue — follow the
disclosure process in
[SECURITY.md](https://github.com/kici-dev/kici-public/blob/main/SECURITY.md).

## Reference

<!-- BEGIN GENERATED: kici-notifications-and-diagnostics (do not edit; run the doc generator) -->

### `kici diagnostics`

Show orchestrators, scalers, and agents (mirrors the dashboard Infrastructure page)

Synopsis: `kici diagnostics [options]`

**Options**

| Option                | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `--json`              | `false` | Output raw JSON                     |
| `--verbose`           | `false` | Show extended per-agent fields      |
| `--orchestrator <id>` |         | Scope the tree to one connection id |

### `kici doctor`

Diagnose your KiCI setup and print the exact next command for each problem

Synopsis: `kici doctor [options]`

**Options**

| Option              | Default | Description                        |
| ------------------- | ------- | ---------------------------------- |
| `--json`            | `false` | Output raw JSON instead of a table |
| `--kici-dir <path>` | `.kici` | Path to the .kici directory        |

### `kici feedback`

Print how to report a discrepancy between what KiCI advertises and what it does. Files nothing.

Synopsis: `kici feedback [options]`

**Options**

| Option   | Default | Description                                          |
| -------- | ------- | ---------------------------------------------------- |
| `--open` |         | Open the prefilled issue form in the default browser |
| `--json` |         | Emit the reporting contract as JSON                  |

### `kici notifications`

Manage the org's notification channels, subscriptions, and Slack roster

Synopsis: `kici notifications`

### `kici notifications channels`

Manage notification channels (Slack / email)

Synopsis: `kici notifications channels`

### `kici notifications channels add`

Add a notification channel

Synopsis: `kici notifications channels add [options]`

**Options**

| Option                 | Default | Description                                    |
| ---------------------- | ------- | ---------------------------------------------- |
| `--type <slack         | email>` |                                                | Channel transport type |
| `--name <name>`        |         | Channel display name                           |
| `--connection <id>`    |         | Slack connection id (slack channels)           |
| `--slack-channel <id>` |         | Slack channel id (slack channels)              |
| `--from-name <name>`   |         | Sender name (email channels)                   |
| `--reply-to <email>`   |         | Reply-to address (email channels)              |
| `--org <id>`           |         | Target organization (overrides the active org) |

### `kici notifications channels list`

List notification channels

Synopsis: `kici notifications channels list [options]`

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |
| `--json`     |         | Output as JSON                                 |

### `kici notifications channels remove`

Remove a notification channel

Synopsis: `kici notifications channels remove <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       | Channel id  |

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici notifications roster`

Manage the Layer 1 Slack-identity roster (actor tagging)

Synopsis: `kici notifications roster`

### `kici notifications roster add`

Add a Slack-identity roster entry

Synopsis: `kici notifications roster add [options]`

**Options**

| Option                           | Default   | Description                                    |
| -------------------------------- | --------- | ---------------------------------------------- |
| `--connection <id>`              |           | Slack connection id                            |
| `--subject-kind <kici_user       | git_login | email>`                                        |      | What the subject keys on       |
| `--subject <value>`              |           | The KiCI user sub, git login, or email         |
| `--value <slackIdEmailOrHandle>` |           | Slack member id, email, or @handle             |
| `--input-form <id                | username  | email>`                                        | `id` | How --value should be resolved |
| `--org <id>`                     |           | Target organization (overrides the active org) |

### `kici notifications roster list`

List Slack-identity roster entries

Synopsis: `kici notifications roster list [options]`

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |
| `--json`     |         | Output as JSON                                 |

### `kici notifications roster remove`

Remove a Slack-identity roster entry

Synopsis: `kici notifications roster remove <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description     |
| -------- | -------- | -------- | --------------- |
| `id`     | yes      | no       | Roster entry id |

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici notifications subscriptions`

Manage notification subscriptions

Synopsis: `kici notifications subscriptions`

### `kici notifications subscriptions add`

Add a notification subscription

Synopsis: `kici notifications subscriptions add [options]`

**Options**

| Option                       | Default | Description                                         |
| ---------------------------- | ------- | --------------------------------------------------- |
| `--channel <id>`             |         | Target channel id                                   |
| `--on-status <csv>`          |         | Statuses to notify on (e.g. failed,success)         |
| `--level <run                | job>`   | `run`                                               | Subscription granularity |
| `--scope <org                | team    | user                                                | actor>`                  | `org` | Subscription scope |
| `--scope-id <id>`            |         | Scope id (required for team/user scope)             |
| `--repo-glob <glob>`         |         | Match runs whose repo matches this glob             |
| `--workflow-glob <glob>`     |         | Match runs whose workflow matches this glob         |
| `--job-glob <glob>`          |         | Match jobs matching this glob (job level)           |
| `--mentions <csv>`           |         | Literal Slack member/group ids or emails to mention |
| `--recipient-override <csv>` |         | Override the email recipient set                    |
| `--on-failure-class <csv>`   |         | Only match these failure classes                    |
| `--accumulate-for <ms>`      |         | Digest accumulation window in milliseconds          |
| `--org <id>`                 |         | Target organization (overrides the active org)      |

### `kici notifications subscriptions list`

List notification subscriptions

Synopsis: `kici notifications subscriptions list [options]`

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |
| `--json`     |         | Output as JSON                                 |

### `kici notifications subscriptions remove`

Remove a notification subscription

Synopsis: `kici notifications subscriptions remove <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description     |
| -------- | -------- | -------- | --------------- |
| `id`     | yes      | no       | Subscription id |

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici report`

Gather a redacted diagnostic bundle to share when reporting an issue

Synopsis: `kici report [options]`

**Options**

| Option                   | Default | Description                                                  |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `--run <id>`             |         | Scope the bundle to a failing run                            |
| `-o, --output <path>`    |         | Where to write the bundle ZIP                                |
| `--metadata <key=value>` |         | Attach metadata (repeatable)                                 |
| `--no-redact`            |         | Do NOT redact secrets (prints a loud warning)                |
| `--upload`               |         | Upload the bundle privately to KiCI and print a reference id |
| `--message <text>`       |         | Describe the problem (sent with --upload)                    |
| `--email <address>`      |         | Contact address for follow-up (sent with --upload)           |
| `--kici-dir <path>`      | `.kici` | Path to the .kici directory                                  |

### `kici report list`

List the issue reports you have uploaded

Synopsis: `kici report list [options]`

**Options**

| Option   | Default | Description     |
| -------- | ------- | --------------- |
| `--json` | `false` | Output raw JSON |

### `kici report withdraw`

Withdraw an uploaded report and delete its bundle

Synopsis: `kici report withdraw <ref>`

**Arguments**

| Argument | Required | Variadic | Description                            |
| -------- | -------- | -------- | -------------------------------------- |
| `ref`    | yes      | no       | Reference id of the report to withdraw |

### `kici verify-attestation`

Verify a KiCI provenance attestation bundle offline

Synopsis: `kici verify-attestation [artifact] [options]`

**Arguments**

| Argument   | Required | Variadic | Description                                                              |
| ---------- | -------- | -------- | ------------------------------------------------------------------------ |
| `artifact` | no       | no       | Artifact path to digest-check against the attestation subject (optional) |

**Options**

| Option                       | Default | Description                                                                                                                          |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--bundle <path>`            |         | Path or URL to the attestation bundle JSON                                                                                           |
| `--trust-root <url-or-file>` |         | Trusted issuer URL, or a self-contained { issuer, jwks } file (default: your configured orchestrator, else the hosted KiCI platform) |
| `--audience <aud>`           |         | Expected token audience                                                                                                              |
| `--json`                     | `false` | Output structured JSON result                                                                                                        |

<!-- END GENERATED: kici-notifications-and-diagnostics -->
