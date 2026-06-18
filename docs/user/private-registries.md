---
title: Private npm registries
description: Authenticate `npm install` against private registries (CodeArtifact, GitHub Packages, Verdaccio, …) from a workflow's `.kici/package.json`
---

A workflow's `.kici/package.json` may depend on packages published to a private registry — your org's internal CodeArtifact, a GitHub Packages scope, a self-hosted Verdaccio, JFrog, Cloudsmith, GitLab, etc. KiCI ships two ways to authenticate `npm install` against those registries from inside a job, plus an escape hatch for short-lived tokens.

## Choose a path

| Path                                                    | When to pick it                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Option A — `registries:` block in the workflow**      | The token is a long-lived secret you rotate manually (GH Packages PAT, CodeArtifact IAM access key, Verdaccio service token). KiCI manages the `.npmrc` for you.                                              |
| **Option C — Committed `.kici/.npmrc` + `installEnv:`** | You already have an `.npmrc` you want to keep verbatim (e.g. it carries an `audit=false` line, a custom CA, or a complex multi-scope mapping). KiCI just supplies the env vars your `${VAR}` references need. |
| **Setup-step pattern (short-lived tokens)**             | The token is minted at workflow time (CodeArtifact authorization token, GCP Artifact Registry token). A `setup` job runs the cloud CLI, writes a fresh `.kici/.npmrc`, and the install jobs read it.          |

The two channels (Option A and Option C) compose. If you declare both, the agent's auto-generated lines come **after** your committed `.npmrc`, so npm's last-wins semantics let agent-managed registries override committed ones — never the other way around.

## Option A — `registries:` block

Declare the registry in your workflow file and point its `tokenSecret` at a scoped secret using the qualified `<environment>:<secret-name>` syntax. The orchestrator resolves the token at dispatch time and the agent applies it for one `npm install` only.

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('build', {
  on: [push({ branches: ['main'] })],
  registries: [
    {
      url: 'https://npm.pkg.github.com/',
      scope: '@my-org',
      tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
    },
  ],
  jobs: [
    job('build', {
      runsOn: 'default',
      environment: 'production',
      steps: [
        step('install-and-build', async (ctx) => {
          // .kici/package.json can now reference @my-org/* packages
          await ctx.$`npm run build`;
        }),
      ],
    }),
  ],
});
```

Per-field rules:

- **`url`** — Must be HTTPS. HTTP is permitted only for `localhost` / `127.0.0.0/8` / `::1` / `*.local` hosts, or when an operator has flipped the org-level `allow_http_npm_registries` toggle (see [`kici-admin org-settings allow-http-npm`](/operator/kici-admin-cli#allow-http-npm--permit-non-https-private-npm-registries)).
- **`scope`** — Optional. When present, the registry serves only that scope (`@my-org`). When absent, this entry becomes the **default** registry — at most one entry may omit `scope`.
- **`tokenSecret`** — Mandatory `<environment>:<secret-name>`. The orchestrator looks up the secret in the named environment via the per-environment secret resolver. The bare name **must not** contain a colon.
- **`alwaysAuth`** — Defaults to `true`. Forces npm to send the token on every request (even GETs), which is what most managed-registry providers require.

### How tokens reach `npm install`

The agent never writes the token bytes to your `.kici/.npmrc`. Each registry token is exposed to the install subprocess as a job-scoped env var (`KICI_NPM_TOKEN_<jobIdShort>_<i>`), and the on-disk auth line carries a `${VAR}` reference that npm substitutes at read time. The job-scoped nonce makes the env var name unguessable from outside the install subprocess.

After the install completes (success or failure), the agent restores the original `.kici/.npmrc` — your committed file is never permanently modified.

## Option C — committed `.kici/.npmrc` + `installEnv:`

If you'd rather hand-craft the `.npmrc`, commit it under `.kici/.npmrc` with `${VAR}` placeholders, then list each variable in the workflow's `installEnv:` block using the same qualified syntax as `tokenSecret`.

```ini
# .kici/.npmrc
@my-org:registry=https://npm.example.com/
//npm.example.com/:_authToken=${MY_NPM_TOKEN}
//npm.example.com/:always-auth=true
audit=false
```

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('build', {
  on: [push({ branches: ['main'] })],
  installEnv: ['production:MY_NPM_TOKEN'],
  jobs: [
    job('build', {
      runsOn: 'default',
      environment: 'production',
      steps: [step('build', async (ctx) => ctx.$`npm run build`)],
    }),
  ],
});
```

The orchestrator resolves `MY_NPM_TOKEN` from the `production` environment's secret store and seeds it as `MY_NPM_TOKEN` (bare name) in the install subprocess. Your committed `.npmrc` reads it through `${MY_NPM_TOKEN}`.

This path is the right answer when:

- The `.npmrc` carries non-auth knobs (`audit=false`, `legacy-peer-deps=true`, custom CA bundles).
- You want a single source of truth for registry topology that `npm` tooling outside KiCI can consume too.
- The auth lines reference the **same** env var across multiple registries.

## Short-lived tokens (CodeArtifact, GCP Artifact Registry)

AWS CodeArtifact authorization tokens expire after 12 hours; GCP Artifact Registry tokens after 60 minutes. Storing one as a long-lived `tokenSecret` does not work — by the time a build runs, the token may be expired.

The supported pattern is a **setup job** that mints a fresh token, writes `.kici/.npmrc`, and downstream jobs install with it.

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('build', {
  on: [push({ branches: ['main'] })],
  jobs: [
    job('mint-codeartifact-token', {
      runsOn: 'default',
      environment: 'production',
      steps: [
        step('mint', async (ctx) => {
          const awsKey = await ctx.secrets.get('AWS_ACCESS_KEY_ID');
          const awsSecret = await ctx.secrets.get('AWS_SECRET_ACCESS_KEY');
          process.env.AWS_ACCESS_KEY_ID = awsKey;
          process.env.AWS_SECRET_ACCESS_KEY = awsSecret;

          const token = (
            await ctx.$`aws codeartifact get-authorization-token --domain my-domain --query authorizationToken --output text`
          ).stdout.trim();

          // Write directly into the workspace's .kici/ — the next job reuses the same workspace.
          const npmrc = [
            '@my-org:registry=https://my-domain-1234567890.d.codeartifact.eu-central-1.amazonaws.com/npm/workflow-deps/',
            `//my-domain-1234567890.d.codeartifact.eu-central-1.amazonaws.com/npm/workflow-deps/:_authToken=${token}`,
            '//my-domain-1234567890.d.codeartifact.eu-central-1.amazonaws.com/npm/workflow-deps/:always-auth=true',
            '',
          ].join('\n');
          await ctx.$`tee .kici/.npmrc`.stdin(npmrc);
        }),
      ],
    }),
    job('build', {
      runsOn: 'default',
      environment: 'production',
      needs: ['mint-codeartifact-token'],
      steps: [step('build', async (ctx) => ctx.$`npm run build`)],
    }),
  ],
});
```

The same pattern works for GCP Artifact Registry — replace the `aws codeartifact` call with `gcloud auth print-access-token`. The manual setup-step shown here is the supported path for these short-lived flows.

## Provider-specific examples

### GitHub Packages

```typescript
registries: [
  {
    url: 'https://npm.pkg.github.com/',
    scope: '@my-org',
    tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
  },
],
```

Mint the token from a fine-grained PAT with `read:packages` scope, store it as a scoped secret in the `production` environment.

### GitLab Packages

```typescript
registries: [
  {
    url: 'https://gitlab.example.com/api/v4/projects/123/packages/npm/',
    scope: '@my-group',
    tokenSecret: 'production:GITLAB_DEPLOY_TOKEN',
  },
],
```

Use a project- or group-level deploy token with `read_package_registry` scope.

### Verdaccio (self-hosted)

```typescript
registries: [
  {
    url: 'https://npm.internal.example.com/',
    tokenSecret: 'production:VERDACCIO_TOKEN',
  },
],
```

For local development against a Verdaccio container, point at `http://localhost:4873/` — the loopback exemption means the operator does NOT need to flip `allow_http_npm_registries`.

### JFrog Artifactory

```typescript
registries: [
  {
    url: 'https://artifactory.example.com/artifactory/api/npm/npm-virtual/',
    scope: '@my-org',
    tokenSecret: 'production:JFROG_API_KEY',
  },
],
```

### Cloudsmith

```typescript
registries: [
  {
    url: 'https://npm.cloudsmith.io/my-org/my-repo/',
    scope: '@my-org',
    tokenSecret: 'production:CLOUDSMITH_TOKEN',
  },
],
```

## Security model

- **Per-environment scoping.** Every `tokenSecret` and `installEnv` entry is qualified with an environment name. The orchestrator runs the same protection-rule pipeline (branch / trust / concurrency / reviewer / wait-timer) against each named environment **before** resolving any secret, so a workflow that wants a `production` token from a feature branch is rejected exactly like a job that tries to deploy to `production` from a feature branch. A reviewer-gated install environment **pauses** the whole workflow dispatch as a workflow-scoped held run instead of resolving the token — see [Reviewer-gated installs](#reviewer-gated-installs) below.
- **Untrusted contributors get no tokens.** When a fork PR is dispatched and the contributor-trust resolution returns anything other than `trusted`, the orchestrator strips both `npmRegistries` and `installEnvSecrets` out of the dispatch. The install runs without auth and fails naturally on the first private dep — fork PRs cannot ever observe a registry token, even if a misconfigured environment lacks an explicit `requiredTrustTier`.
- **Lifecycle scripts disabled.** Whenever a private registry is in scope, the agent runs the install with `--ignore-scripts` (npm or pnpm alike). A malicious `preinstall` / `postinstall` hook in committed `package.json` cannot read the synthesized token env vars, even though they exist in the install subprocess. For a pnpm workspace, the agent builds your in-repo dependency closure as a separate step **after** the install's auth is torn down, so build scripts never see the tokens either.
- **Stderr is redacted.** If the install fails, the agent masks every token literal out of the surfaced stderr / stdout chunks before logging.
- **Job-scoped env-var names.** The synthesized auth env var is `KICI_NPM_TOKEN_<jobIdShort>_<i>` where `jobIdShort` is the first 8 chars of the dispatched job id. The name is unguessable from outside the install subprocess and not reused across jobs.
- **`.npmrc` restored.** Whatever the agent appended for one install is stripped (or the file unlinked) on cleanup, so the workspace is never permanently modified.

## Reviewer-gated installs

When the named install environment carries a protection rule that holds — a required reviewer (`hold`) or a wait timer (`wait`) — the install gate **pauses the whole workflow dispatch** instead of rejecting it. The run is created in the `held` state, no jobs are queued, and a workflow-scoped row appears on the held-runs page with a `Workflow` scope badge.

- **Reviewer hold:** the run waits for an approver. On approval the dispatch resumes from the install gate, resolves the token, and dispatches its jobs as a normal run. On rejection the run transitions to `cancelled` — no jobs ever run.
- **Wait timer:** the run waits out the timer and resumes automatically when it elapses.

A `reject` protection outcome (for example a disabled environment or a branch the environment forbids) still fails the dispatch loudly with a clear reason, exactly as before — the orchestrator never dispatches a run with an unresolved install token.

## Limitations

- **`registries:` is workflow-level only in v1.** Per-job overrides aren't supported — there is one shared `.kici/` per workspace, so a per-job `registries:` would be physically nonsensical.
- **Container registries (Docker Hub, ECR, GHCR) are out of scope.** This feature covers **npm** registry auth only. Container image pulls travel through the executor backend's own credential paths.

## Observability

The orchestrator exposes Prometheus counters and a histogram under the `kici_orch_install_secrets_*` prefix on its `/metrics` endpoint. They populate the **Install secrets resolution** Grafana dashboard and let operators graph install-secrets activity without digging through Loki.

| Metric                                                        | Type      | Labels                         | What it tells you                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kici_orch_install_secrets_decisions_total`                   | Counter   | `decision`, `reason`           | Pass / reject / hold volume. `decision=hold` (reason `held`) counts dispatches paused at a reviewer-gated install environment. Reject reasons enumerate the failure mode: `malformed_ref`, `invalid_url_scheme`, `env_not_found`, `protection_rule_block`, `missing_token`, `missing_install_env`, etc. |
| `kici_orch_install_secrets_npm_registry_used_total`           | Counter   | `channel`, `provider`, `scope` | Per-channel + per-scope usage. `channel=registries` is Option A, `channel=install_env` is Option C. `scope=default` marks a no-scope default registry; `scope=-` marks Option C entries.                                                                                                                |
| `kici_orch_install_secrets_contributor_stripped_total`        | Counter   | `trust_tier`                   | Number of dispatches where registry tokens were stripped because the contributor tier wasn't `trusted` (fork PRs from unknown / known contributors). Expected to be 0 in single-tenant orgs.                                                                                                            |
| `kici_orch_install_secrets_token_resolution_duration_seconds` | Histogram | `environment`                  | Latency of per-environment secret resolution. Pathological tails (>500ms) usually mean a Vault timeout or a slow Postgres replica.                                                                                                                                                                      |

The dashboard JSON lives at `infra/terraform/modules/grafana/dashboards/install-secrets.json`; if you maintain your own monitoring stack, you can import it directly.

## See also

- [Secrets](secrets.md) — how to seed the `<environment>:<secret-name>` values referenced by `tokenSecret` / `installEnv`.
- [Environments](environments.md) — protection rules (`branch_restrictions`, `requires_review`, `minimum_trust`) that the install gate inherits.
- [Operator: `kici-admin org-settings`](/operator/kici-admin-cli#org-settings----org-level-security-policy) — the `allow_http_npm_registries` toggle and other org-scoped knobs.
