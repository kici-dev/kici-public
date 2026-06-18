---
title: Integration patterns
description: Workflow chaining, generic webhooks, Stripe, self-hosted git forges, plain GitHub repos
---

Use internal event triggers to chain workflows together. Workflow A completes, emits an event (or the system auto-emits a completion event), and Workflow B triggers in response.

### Using system completion events

The orchestrator automatically emits `workflow_complete` and `job_complete` events. Use `workflowComplete()` and `jobComplete()` triggers to listen for them:

```typescript
import { workflow, job, step, push, workflowComplete } from '@kici-dev/sdk';

// Workflow A: deploy on push to main
export const deploy = workflow('deploy', {
  on: push({ branches: 'main' }),
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy', async ({ $ }) => {
          await $`./scripts/deploy.sh`;
        }),
      ],
    }),
  ],
});

// Workflow B: runs after deploy succeeds
export const postDeploy = workflow('post-deploy', {
  on: workflowComplete({ name: 'deploy', status: ['success'] }),
  jobs: [
    job('notify', {
      runsOn: 'linux',
      steps: [
        step('slack', async ({ $ }) => {
          await $`./scripts/notify-slack.sh "Deploy succeeded"`;
        }),
      ],
    }),
  ],
});
```

`workflowComplete()` / `jobComplete()` start a **separate** workflow run that reacts to the prior one finishing, gated on its status. They are the right tool when a _different_ workflow should respond. When you instead need to add more jobs to the **same** run based on what a job just produced — fanning out follow-up work from a prior job's outputs — use a result-aware generator (next section), not a completion-event chain.

### Same-run discovery → fan-out

A result-aware [`dynamicJob(group, { needs, generate })`](../sdk/rules-matrix-dynamic.md#dynamicjob--result-aware-generation) is deferred until its declared upstreams complete, then runs with their frozen outputs as `ctx.needs` — so a discovery job can emit a list at runtime and the generator fans out one follow-up job per item, all in the same run:

```typescript
import { workflow, job, step, push, dynamicJob, z } from '@kici-dev/sdk';

const discover = job('discover', {
  runsOn: 'linux',
  steps: [
    step('list-services', {
      outputs: { services: z.array(z.string()) },
      run: async ({ $ }) => {
        const out = await $`ls services/`;
        return { services: out.stdout.trim().split('\n') };
      },
    }),
  ],
});

const deployEach = dynamicJob('deploys', {
  needs: ['discover'],
  generate: async ({ ctx }) =>
    ctx.needs.discover.result.services.map((svc) =>
      job(`deploy-${svc}`, {
        runsOn: 'linux',
        run: async ({ $ }) => {
          await $`./scripts/deploy.sh ${svc}`;
        },
      }),
    ),
});

export default workflow('deploy-discovered-services', { on: push(), jobs: [discover, deployEach] });
```

Contrast: this keeps everything in one run with results flowing job→job. A cross-workflow `jobComplete()` chain (above) reacts to a job finishing but only sees its _status_, in a new run — use that when the reacting logic belongs to a different workflow.

### Using custom events

For richer payload data, emit custom events from steps using `ctx.emit()`:

```typescript
import { workflow, job, step, push, kiciEvent } from '@kici-dev/sdk';

// Workflow A: deploy and emit custom event with payload
export const deploy = workflow('deploy', {
  on: push({ branches: 'main' }),
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy', async ({ $ }) => {
          await $`./scripts/deploy.sh`;
        }),
        step('notify', async (ctx) => {
          await ctx.emit('deploy-complete', {
            env: 'prod',
            version: '1.2.3',
          });
        }),
      ],
    }),
  ],
});

// Workflow B: triggered by custom event with payload matching
export const postDeploy = workflow('post-deploy', {
  on: kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } }),
  jobs: [
    job('smoke-test', {
      runsOn: 'linux',
      steps: [
        step('test', async ({ $ }) => {
          await $`./scripts/smoke-test.sh`;
        }),
      ],
    }),
  ],
});
```

Custom events are delivered immediately (mid-workflow, not queued until workflow completion).

## Generic webhook integration

Trigger workflows from non-GitHub sources like ArgoCD, Jenkins, Grafana, or any HTTP service. Generic webhook sources are configured via the orchestrator admin API, and workflows listen using `genericWebhook()`.

```typescript
import { workflow, job, step, genericWebhook } from '@kici-dev/sdk';

// Triggered by ArgoCD deploy events
export default workflow('on-argocd-deploy', {
  on: genericWebhook({ source: 'argocd', events: ['deploy.success'] }),
  jobs: [
    job('post-deploy', {
      runsOn: 'linux',
      steps: [
        step('verify', async ({ $, rawPayload }) => {
          // rawPayload contains the full webhook body from ArgoCD
          await $`./scripts/verify-deploy.sh`;
        }),
      ],
    }),
  ],
});
```

See the [Operator guide: event routing](../../operator/event-routing.md) for how to set up generic webhook sources, verification methods, and trust relationships.

## Stripe webhook handler

Process payment events from Stripe using `genericWebhook()` with HMAC-SHA256 signature verification. This pattern applies to any external service that sends signed HTTP webhooks.

```typescript
import { workflow, job, step, genericWebhook } from '@kici-dev/sdk';

export default workflow('stripe-invoice-handler', {
  on: genericWebhook({
    source: 'stripe',
    events: ['invoice.paid'],
    auth: {
      method: 'hmac-sha256',
      secret: 'stripe-signing-key',
      signatureHeader: 'stripe-signature',
    },
    description: 'Process Stripe invoice.paid events',
  }),
  jobs: [
    job('process-invoice', {
      runsOn: 'linux',
      steps: [
        step('extract-customer', async ({ $, log }) => {
          log.info('Processing paid invoice from Stripe');
          await $`./scripts/process-invoice.sh`;
        }),
        step('update-billing', async ({ $ }) => {
          await $`./scripts/update-billing-records.sh`;
        }),
        step('notify-team', async ({ $ }) => {
          await $`./scripts/notify-billing-team.sh`;
        }),
      ],
    }),
  ],
});
```

**Prerequisites:**

- An operator must create a generic webhook source named `stripe` via the admin API. See [Operator guide: creating a source](../../operator/event-routing.md#creating-a-source).
- The `stripe-signing-key` secret must contain your Stripe webhook signing secret.
- This workflow uses the [registration model](../events.md#the-registration-model) -- it will not trigger until you push to your default branch.

## Self-hosted git forge (Gogs, Forgejo, Gitea)

KiCI has no native provider for Gogs, Forgejo, or Gitea, but these forges send HMAC-SHA256-signed webhooks with a predictable header layout. Model them as a generic webhook source: point the forge's webhook at the orchestrator (or the Platform relay), configure HMAC verification with the shared secret, and map the forge's event header so `genericWebhook()` can match on it.

**Operator setup:**

```bash
# Forgejo / Gitea send event name in X-Gitea-Event and signature in X-Gitea-Signature.
# Gogs uses X-Gogs-Event and X-Gogs-Signature (same HMAC-SHA256 hex-digest format).
kici-admin source add generic \
  --org my-org \
  --name forgejo-main \
  --verification hmac_sha256 \
  --secret @/path/to/webhook-secret.txt \
  --event-type-header X-Gitea-Event \
  --rate-limit 120
```

Note the returned source ID, then register a webhook in the forge pointing at `https://<platform>/webhooks/<orgId>/generic/<sourceId>` (or the orchestrator's direct URL). Set content type to `application/json` and paste the same secret.

**Workflow:**

```typescript
import { workflow, job, step, genericWebhook } from '@kici-dev/sdk';

export default workflow('on-forgejo-push', {
  on: genericWebhook({
    source: 'forgejo-main',
    events: ['push'], // Forgejo/Gitea sends 'push', 'pull_request', 'issues', etc.
    match: { '$.ref': 'refs/heads/main' }, // JSONPath filter on the payload
  }),
  jobs: [
    job('react-to-push', {
      runsOn: 'linux',
      steps: [
        step('log', async ({ rawPayload, log }) => {
          const ref = (rawPayload as { ref?: string }).ref;
          log.info(`Forgejo push to ${ref}`);
        }),
      ],
    }),
  ],
});
```

**Caveat — cloning:** generic webhook sources deliver only the payload; they do not carry a clone token, and KiCI's automatic pre-step clone (`packages/agent/src/checkout/git-clone.ts`) is GitHub-only today (HTTPS + `http.extraHeader` Basic auth with a GitHub installation token). Three practical patterns:

- **Mirror to GitHub and fan out.** Keep the repo on GitHub, register the workflow via a GitHub default-branch push, and have Gogs/Forgejo webhooks fan out via [cross-source delivery](../../architecture/webhooks/webhook-delivery.md#cross-source-delivery). The clone runs against the GitHub mirror using the GitHub App's token.
- **Clone yourself using a secret.** Set `checkout: false` on the job to skip the framework clone, store an SSH private key or forge personal access token as a secret, and run `git clone` explicitly in the first step. This works for any forge the agent can reach, no mirror needed. You still need a way to **register** the workflow — either keep a one-file GitHub repo whose only job is to own the registration, or bootstrap the registration manually against the orchestrator DB.
- **Self-contained workflow.** No clone at all. The step reads whatever it needs from `rawPayload` (e.g., `rawPayload.after`, `rawPayload.repository.clone_url`) and drives external systems — notifications, deploys, third-party CI triggers.

Manual-clone example (pattern 2) using an SSH deploy key:

```typescript
job('forgejo-ci', {
  runsOn: 'linux',
  checkout: false, // skip framework clone
  steps: [
    step('clone', async ({ $, ctx, rawPayload }) => {
      const sshKey = await ctx.secrets.get('FORGEJO_DEPLOY_KEY');
      await $`mkdir -p ~/.ssh`;
      await $`ssh-keyscan forgejo.example.com >> ~/.ssh/known_hosts`;
      await $({ input: sshKey })`tee ~/.ssh/id_ed25519 > /dev/null`;
      await $`chmod 600 ~/.ssh/id_ed25519`;
      const url = (rawPayload as { repository: { ssh_url: string } }).repository.ssh_url;
      const sha = (rawPayload as { after: string }).after;
      await $`git clone ${url} src && cd src && git checkout ${sha}`;
    }),
    step('test', async ({ $ }) => {
      await $`cd src && pnpm install && pnpm test`;
    }),
  ],
});
```

HTTPS with a forge PAT works the same way — store the token as a secret, `await ctx.secrets.expose('FORGEJO_TOKEN')`, then `git clone https://oauth2:$FORGEJO_TOKEN@forgejo.example.com/org/repo.git`.

**Prerequisites:**

- An operator must create a generic webhook source via `kici-admin source add generic` (see above).
- The forge's webhook secret must match the `--secret` value.
- The workflow uses the [registration model](../events.md#the-registration-model) -- push to the default branch of a registered repo before the first webhook fires.

## Plain GitHub repo webhooks (no GitHub App)

The Gogs/Forgejo/Gitea pattern above also applies when you want to trigger workflows from a GitHub repository **without installing the KiCI GitHub App** — for example because you lack org-admin rights, you're on a restricted GitHub Enterprise tenant, or you simply don't want an App installation. Model the repo-level webhook as a generic source, accepting the same `genericWebhook()`-only ergonomics.

**Operator setup:**

```bash
# GitHub sends event name in X-GitHub-Event and HMAC-SHA256 signature in X-Hub-Signature-256.
kici-admin source add generic \
  --org my-org \
  --name gh-repo-foo \
  --verification hmac_sha256 \
  --secret @/path/to/webhook-secret.txt \
  --event-type-header X-GitHub-Event \
  --rate-limit 120

# Patch the verificationConfig to use GitHub's signature header
# (the CLI has no --signature-header flag; use the admin REST API):
curl -X PATCH https://<orchestrator>/api/v1/admin/generic-sources/<sourceId> \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"verificationConfig":{"secret":"<same-secret>","headerName":"x-hub-signature-256"}}'
```

Then in the GitHub repo, go to **Settings → Webhooks → Add webhook**, set:

- **Payload URL:** `https://<platform>/webhooks/<orgId>/generic/<sourceId>` (or the orchestrator's direct URL)
- **Content type:** `application/json`
- **Secret:** the same secret
- **Events:** pick what you care about (e.g., `push`, `pull_request`)

**Workflow:**

```typescript
import { workflow, job, step, genericWebhook } from '@kici-dev/sdk';

export default workflow('on-github-repo-push', {
  on: genericWebhook({
    source: 'gh-repo-foo',
    events: ['push'],
    match: { '$.ref': 'refs/heads/main' },
  }),
  jobs: [
    job('notify', {
      runsOn: 'linux',
      checkout: false, // no App token -> skip auto-clone
      steps: [
        step('log', async ({ rawPayload, log }) => {
          const sha = (rawPayload as { after?: string }).after;
          log.info(`GitHub push ${sha}`);
        }),
      ],
    }),
  ],
});
```

**What you lose compared to the GitHub App** (these are the same cloning / metadata caveats that apply to the Gogs/Forgejo pattern, plus GitHub-specific integrations):

- No auto-clone — `packages/agent/src/checkout/git-clone.ts` uses GitHub App installation tokens to fetch the repo; a generic source has none. Either set `checkout: false` and clone yourself with a PAT/Deploy Key secret (same pattern as the Forgejo manual-clone example above), or keep the workflow self-contained.
- No lock-file fetch — the orchestrator cannot fetch `.kici/kici.lock.json` at the pushed SHA via the GitHub API. The workflow must be pre-registered via the [registration model](../events.md#the-registration-model); ad-hoc per-commit workflow discovery that a GitHub App push gives you is not available.
- No changed-files enrichment — `event.changedFiles` is empty. Use JSONPath `match` on `rawPayload.commits[*].added/modified/removed` if you need path filters.
- No check-run integration — KiCI cannot post Check Run results back to GitHub.
- Workflow authors must use `genericWebhook()`, not `push()` / `pr()` / `webhook()` — the latter three only match events delivered through the native GitHub App provider.

**When to use it anyway:** trigger-only workflows that don't need the cloned repo — posting Slack messages, kicking off external deploys, forwarding to downstream systems, or exposing GitHub repo events as `genericWebhook` for same-org [cross-source fan-out](../../architecture/webhooks/webhook-delivery.md#cross-source-delivery). For anything that compiles, tests, or checks code, install the GitHub App instead.

## Nightly cron build
