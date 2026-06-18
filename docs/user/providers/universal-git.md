---
title: Universal-git provider
description: Connect Forgejo, Gitea, Gogs, GitLab, or plain GitHub via webhook + PAT or SSH deploy key
---

The **universal-git** provider lets KiCI treat any git forge that speaks a
GitHub-shaped webhook payload as a first-class source. That covers Forgejo,
Gitea, Gogs, GitLab, plain GitHub (without the App), and any custom
webhook-driven forge you can describe in JSONPath.

> **Want Check runs on pull requests?** Use the [GitHub App
> provider](github.md) instead — it clones via short-lived installation
> tokens and drives KiCI's enriched Checks UI out of the box. The
> universal-git `github-repo` preset is the right fallback when you
> can't install an App.

The orchestrator:

1. receives the forge's webhook,
2. clones the repo via HTTPS (PAT) or SSH (deploy key) to read the lock
   file at `.kici/kici.lock.json`,
3. dispatches workflows that match the push / pull_request event.

No mirror, no GitHub App, no `checkout: false` escape hatch. The same
trigger matching, global-workflow policy, and agent execution pipeline
that back the GitHub App source also serve universal-git sources.

> **No shared filesystem between orchestrator and agent?** Universal-git is
> the right choice for the **remote-agent** case — point it at an `http://`
> git server and the agent clones over the network. When the repo instead
> lives on the agent's own filesystem (a vendored / operator-curated repo),
> use a [local `file://` source](./local-file.md) and drive it with the
> `kici-admin` CLI.

## Which preset do I need?

KiCI ships canonical presets so you don't have to spell out JSONPath for
every forge:

| Preset        | Forge                                   | Webhook header   |
| ------------- | --------------------------------------- | ---------------- |
| `forgejo`     | Forgejo                                 | `X-Gitea-Event`  |
| `gitea`       | Gitea                                   | `X-Gitea-Event`  |
| `gogs`        | Gogs                                    | `X-Gogs-Event`   |
| `gitlab-repo` | GitLab (per-project webhooks)           | `X-Gitlab-Event` |
| `github-repo` | Plain GitHub (per-repo webhook, no App) | `X-GitHub-Event` |
| `custom`      | Anything else                           | You supply it    |

Pick `custom` only when the forge's payload structure or event header
deviates from GitHub's — you'll then supply `payloadPaths` and
`eventMapping` explicitly.

## Create a source (PAT)

```bash
kici-admin source add generic \
  --org <orgId> \
  --name forgejo-main \
  --verification hmac_sha256 \
  --secret <random-hex> \
  --preset forgejo \
  --git-url-template 'https://forgejo.example.com/{owner}/{name}.git' \
  --credential-ref pat \
  --credential-type pat \
  --credential-user bot-user
```

Then seed the PAT under the source's own secret scope:

```bash
# The scope __source__/<sourceId> is the orchestrator's convention for
# source-level credentials. Use the sourceId printed by `source add`.
kici-admin secret set <orgId> "__source__/<sourceId>" pat --value "<your-forgejo-pat>"
```

Finally, configure the forge to deliver webhooks to:

```
https://<platform-host>/webhook/<orgId>/generic/<source-name>
```

with the same secret you passed to `--secret`.

## SSH deploy key

For SSH instead of HTTPS:

1. **Generate an Ed25519 deploy key.** Ed25519 is the recommended default.

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'kici-forgejo-deploy-key' -f ~/.ssh/forgejo-deploy-key
   ```

   This produces `~/.ssh/forgejo-deploy-key` (private, OpenSSH PEM) and
   `~/.ssh/forgejo-deploy-key.pub` (public).

2. **Register the public key as a deploy key on the forge.** On Forgejo
   / Gitea this is _Repository -> Settings -> Deploy Keys -> Add Key_
   (paste the `.pub` contents). On GitLab it's _Settings -> Repository
   -> Deploy keys_. On plain GitHub it's _Settings -> Deploy keys_.
   Read-only access is enough — KiCI only clones.

3. **Capture the forge's host keys** (needed only for
   `--ssh-host-key-policy pinned`):

   ```bash
   ssh-keyscan -t ed25519,rsa forgejo.example.com > forgejo.known_hosts
   ```

   Inspect the file before trusting it (compare against what the forge
   publishes in its docs) — this is your one chance to pin the key
   out-of-band rather than trust-on-first-use.

4. **Create the source:**

   ```bash
   kici-admin source add generic \
     --org <orgId> \
     --name forgejo-ssh \
     --verification hmac_sha256 \
     --secret <random-hex> \
     --preset forgejo \
     --git-url-template 'ssh://git@forgejo.example.com:22/{owner}/{name}.git' \
     --credential-ref deploy-key \
     --credential-type ssh \
     --ssh-host-key-policy pinned \
     --ssh-known-hosts-pem "@/path/to/forgejo.known_hosts"
   ```

   The `@` prefix on `--ssh-known-hosts-pem` tells the CLI to read the
   file contents.

5. **Store the private key PEM under the source scope:**

   ```bash
   kici-admin secret set <orgId> "__source__/<sourceId>" deploy-key \
     --value "$(cat ~/.ssh/forgejo-deploy-key)"
   ```

   The orchestrator materialises this PEM into a tempfile (mode `0600`)
   at every clone and drives `git` with a purpose-built
   `GIT_SSH_COMMAND` (`IdentitiesOnly=yes`, `BatchMode=yes`, plus the
   host-key flags below). The tempdir is cleaned up as soon as the
   clone finishes.

**Host-key policy:** `accept-new` (default) auto-trusts the forge on
first connection (TOFU) and logs a one-time warning. `pinned` sets
`StrictHostKeyChecking=yes` with `UserKnownHostsFile=<the PEM you
supplied>` and rejects any host key that doesn't match — use this for
production supply-chain hardening. `pinned` requires
`--ssh-known-hosts-pem` (or the equivalent `sshKnownHostsPem` field on
update); the CLI rejects the request otherwise.

**Updating an existing source:** use `kici-admin source update-generic
<id>` with the same flags to switch an HTTPS/PAT source to SSH, rotate
the host-key policy, or flip presets. Pass `--clear-git-config` to
revert the source back to a payload-only generic webhook.

## Credential rotation

To rotate a PAT or SSH key, overwrite the value under the same scope +
key and the next clone picks it up:

```bash
kici-admin secret set <orgId> "__source__/<sourceId>" pat --value "<new-pat>"
```

The orchestrator re-reads the secret at each clone. No source update
needed.

## Global workflows

Universal-git sources participate in the org-wide global-workflow model
exactly like GitHub App sources — a global workflow authored in one
source can dispatch against pushes from a different source in the same
org (including across forges), with each clone using its own bundle's
credentials.

Enable and tune the policy via the org-settings CLI. Settings are
org-scoped (one row per `customer_id`); each list entry can optionally
pin to a specific source via `--source <routingKey>`:

```bash
# Enable global workflows for the org
kici-admin org-settings global-workflows set-enabled true \
  --customer-id <orgId>

# Allow authors from any source in the org
kici-admin org-settings global-workflows allow-add \
  'forgejo.example.com/ci-workflows/*' \
  --customer-id <orgId>

# Allow authors only when the workflow lives on a specific source
kici-admin org-settings global-workflows allow-add \
  'forgejo.example.com/ci-workflows/*' \
  --customer-id <orgId> \
  --source "generic:<orgId>:<sourceId>"

# Forbid events from a specific source from firing any global workflow
kici-admin org-settings global-workflows deny-add \
  'forgejo.example.com/untrusted/*' \
  --customer-id <orgId> \
  --source "generic:<orgId>:<sourceId>"
```

See [Global workflows](../../architecture/global-workflows.md) for the
policy model (`isWorkflowRepoAllowed` + `isSourceRepoAllowed` +
`isElevatedAccessAllowed`) and the cross-provider dispatch contract.

## Routing-key collisions

When a user has both a GitHub App source and a universal-git source
targeting the same `owner/repo`, each creates its own registration and
each fires its own run on a matching push. This is intentional: the two
sources are independently authenticated and may resolve different lock
files. If you want deduplication, either:

- constrain one side via `global_workflow_denied_repos`, or
- don't create both sources.

## Troubleshooting

**The webhook hits the orchestrator but no run fires.** Check the
orchestrator log for `Skipping global workflow dispatch` or
`no registrations for event`. Most common cause: the webhook event
header doesn't match the preset's `eventMapping`. For `custom` sources,
make sure the `eventMapping` array includes every value the forge
actually sends (they can vary by event type).

**Clone fails with 401.** The source-scoped secret is missing or
wrong. Verify with:

```bash
kici-admin secret list <orgId> "__source__/<sourceId>"
```

**Clone fails with 403 `default branch` fetch.** The PAT lacks
read-access to the repo or the SSH deploy key isn't registered on it.

**SSH clone fails with host-key rejection.** If you set
`sshHostKeyPolicy: pinned`, verify the known-hosts PEM matches the
forge's current key. If you're still using `accept-new`, the orch's
`~/.ssh/known_hosts` has a stale entry — clear it or flip to `pinned`
with the right PEM.
