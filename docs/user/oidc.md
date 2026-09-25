---
title: Workload identity with OIDC
description: 'Mint short-lived OIDC identity tokens in a step and exchange them with Cloudsmith, AWS, or any service that federates with your orchestrator'
---

A job step can prove **which run it is** to an outside service without a stored
secret. The orchestrator mints a short-lived OIDC identity token for the step,
signs it with its own key, and the service verifies it against the
orchestrator's public keys. Your repository holds no long-lived credential for
that service; the exchanged credential exists only inside the step.

The orchestrator is the OIDC issuer. It publishes the discovery document and
the key set under `KICI_ORCHESTRATOR_PROVENANCE_ISSUER`, and the service you
exchange with must be able to reach that base URL — see
[network requirements](../operator/network-requirements.md) and
[signing keys](../operator/orchestrator/signing-keys.md) for the operator side.

## Requesting an identity token

Call `ctx.kici.oidc.token({ audience })` from a step when you need the identity
token for a tool that trusts your orchestrator:

```typescript
step('mint', async (ctx) => {
  const minted = await ctx.kici.oidc.token({ audience: 'sigstore' });
  if ('deferred' in minted) throw new Error(`ID token deferred: ${minted.code}`);
  const { token, expiresIn } = minted;
  ctx.log.info(`Got an ID token valid for ${expiresIn}s`);
  // Hand `token` to a tool that exchanges it with a service trusting the issuer.
});
```

The result is either the minted token or `{ deferred: true, code }` when the
orchestrator could not mint one right now (`unavailable` or `failed`). An
exchange needs a live token, so a step that exchanges it fails on `deferred`;
[`ctx.attestProvenance`](./provenance.md) handles that case for you by freezing
the statement and fulfilling it later. The token is a short-lived (about 10
minutes) signed JWT scoped to the current run and job. Its identity claims
(`repository`, `ref`, `sha`, `kici_run_id`, `kici_job_id`) are derived by the
orchestrator from the run context, so a step cannot spoof them. The returned
token value is automatically masked in step logs, and the step never holds
signing credentials — the orchestrator mints and signs the token on the step's
behalf from its own run records. It is only available inside a running job step.

## Exchanging the token with an external service

Any service that federates with a generic OIDC issuer can trust your
orchestrator directly. The service fetches your issuer's discovery document
(`<issuer>/.well-known/openid-configuration`) and public keys, so the issuer
base URL must be reachable from that service.

The pattern is the same everywhere: request a token with the audience the
service expects, exchange it for the service's own short-lived credential, and
use that credential inside the step. The workflows below are the ones KiCI's
own test suite runs against a real Cloudsmith organization and a real AWS
account. Each publishes a probe, reads it back, and deletes it. Replace the
probe with your real publish or upload.

Only the ID token is masked in step logs automatically. A credential you
exchange it for is an ordinary string, so do not log it. Hand it to child
processes through a scratch file or the environment, never on a command line.

### Cloudsmith

Cloudsmith exchanges any trusted issuer's token for a Cloudsmith API token
through `POST https://api.cloudsmith.io/openid/<org>/`. The exchanged
credential works as the Cloudsmith API key and as an npm auth token:

<!-- BEGIN GENERATED: oidc-cloudsmith-workflow (do not edit; run the doc generator) -->

```typescript
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflow, job, step, push } from '@kici-dev/sdk';

// Exchanges the job's OIDC ID token with Cloudsmith, publishes a probe npm
// package, reads it back through the Cloudsmith API and deletes it. Every
// Cloudsmith call is made with the exchanged token; nothing here is a secret
// the repo stores.
const ORG = 'my-org';
const REPO = 'my-repo';
const REGISTRY = `https://npm.cloudsmith.io/${ORG}/${REPO}/`;
const PACKAGES_API = `https://api.cloudsmith.io/v1/packages/${ORG}/${REPO}/`;
const PREFIX = '[cloudsmith-oidc]';

function decodeJwtPart(token: string, index: number): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8'));
}

export default workflow('publish', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('publish', {
      runsOn: 'container',
      steps: [
        step('exchange-and-publish', async (ctx) => {
          // 1. Mint. Log the signing algorithm, key id and subject: when the
          //    provider rejects the token, this line says which claim to compare
          //    against the provider's required claims.
          const minted = await ctx.kici.oidc.token({ audience: 'cloudsmith' });
          // A deferred mint is a transient orchestrator-side failure; an exchange
          // needs a live token, so the step fails rather than freezing a statement.
          if ('deferred' in minted) throw new Error(`ID token mint deferred: ${minted.code}`);
          const { token } = minted;
          const header = decodeJwtPart(token, 0);
          const payload = decodeJwtPart(token, 1);
          ctx.log.info(`${PREFIX} alg=${header.alg} kid=${header.kid} sub=${payload.sub}`);

          // 2. Exchange.
          const exchange = await fetch(`https://api.cloudsmith.io/openid/${ORG}/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ oidc_token: token, service_slug: 'ci-publisher' }),
          });
          if (!exchange.ok) {
            const body = (await exchange.text()).split(token).join('<id-token>');
            ctx.log.error(`${PREFIX} exchange=failed status=${exchange.status} body=${body}`);
            throw new Error(`Cloudsmith token exchange failed: ${exchange.status}`);
          }
          const { token: csToken } = (await exchange.json()) as { token: string };
          ctx.log.info(`${PREFIX} exchange=ok`);

          // 3. Publish a unique probe version. The npmrc carrying the exchanged
          //    token is a scratch file the job removes; it never reaches argv.
          //    The run-id segment is prefixed with a letter: a prerelease identifier
          //    made only of digits is numeric under semver and may not start with
          //    0, so a run id such as 01234567 would make npm refuse the version.
          const runIdShort = String(payload.kici_run_id).slice(0, 8);
          const version = `0.0.0-e2e.r${runIdShort}.${Math.floor(Date.now() / 1000)}`;
          const name = '@kici-e2e/oidc-probe';
          const pkgDir = await ctx.mktemp('oidc-probe');
          await writeFile(
            join(pkgDir.path, 'package.json'),
            JSON.stringify({ name, version, license: 'MIT', main: 'index.js' }, null, 2),
          );
          await writeFile(join(pkgDir.path, 'index.js'), 'module.exports = "kici oidc probe";\n');
          const npmrc = await ctx.mktempFile('cloudsmith-npmrc');
          await writeFile(
            npmrc.path,
            `//npm.cloudsmith.io/${ORG}/${REPO}/:_authToken=${csToken}\n`,
          );
          await ctx.$({
            cwd: pkgDir.path,
            env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc.path },
          })`npm publish --registry ${REGISTRY} --tag e2e`;

          // 4. Read it back through the API with the same token, then delete.
          //    The version is unique per run, so it is the whole query.
          const authHeaders = { 'X-Api-Key': `Bearer ${csToken}` };
          const query = encodeURIComponent(`version:${version}`);
          let slug: string | undefined;
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline && !slug) {
            const list = await fetch(`${PACKAGES_API}?query=${query}`, { headers: authHeaders });
            if (list.ok) {
              const rows = (await list.json()) as Array<{
                slug: string;
                is_sync_completed: boolean;
              }>;
              const done = rows.find((r) => r.is_sync_completed);
              if (done) slug = done.slug;
            }
            if (!slug) await new Promise((r) => setTimeout(r, 5_000));
          }
          if (!slug) throw new Error(`${name}@${version} never finished syncing in Cloudsmith`);
          const del = await fetch(`${PACKAGES_API}${slug}/`, {
            method: 'DELETE',
            headers: authHeaders,
          });
          if (!del.ok) throw new Error(`Cloudsmith delete failed: ${del.status}`);
          ctx.log.info(`${PREFIX} verdict=ok package=${name}@${version} deleted=true`);
        }),
      ],
    }),
  ],
});
```

<!-- END GENERATED: oidc-cloudsmith-workflow -->

On the Cloudsmith side, add an OpenID Connect provider under your organization's
authentication settings. The **provider URL** is your orchestrator's issuer
(`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`), and the **service account** is the one
named by `service_slug`. The **required claims** pin which runs may
authenticate. Pin `sub` to the build identity; for production add the fork
conditions from the [claim table](#the-claim-set) below so a fork pull request
cannot exchange a token:

```
sub: repo:acme/app:ref:main:workflow:publish
is_fork: false
head_repository: acme/app
```

### AWS

AWS exchanges the token through `AssumeRoleWithWebIdentity`, which needs no AWS
credential of its own. The step imports `@aws-sdk/client-sts` and
`@aws-sdk/client-s3`; declare both under `dependencies` in `.kici/package.json`
so the compiled workflow can load them.

<!-- BEGIN GENERATED: oidc-aws-workflow (do not edit; run the doc generator) -->

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

// Exchanges the job's OIDC ID token with AWS STS for role credentials, writes
// one probe object to S3, reads it back and deletes it. Nothing here is a
// secret the repo stores; the credentials exist only inside this step.
const REGION = 'eu-central-1';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/ci-uploader';
const BUCKET = 'my-artifacts';
const PREFIX = '[aws-oidc]';

function decodeJwtPart(token: string, index: number): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8'));
}

export default workflow('upload', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('upload', {
      runsOn: 'container',
      steps: [
        step('assume-and-put', async (ctx) => {
          // 1. Mint. Log the signing algorithm, key id, subject and audience:
          //    when STS rejects the token, this line says which claim to compare
          //    against the role's trust policy.
          const minted = await ctx.kici.oidc.token({ audience: 'sts.amazonaws.com' });
          // A deferred mint is a transient orchestrator-side failure; an exchange
          // needs a live token, so the step fails rather than freezing a statement.
          if ('deferred' in minted) throw new Error(`ID token mint deferred: ${minted.code}`);
          const { token } = minted;
          const header = decodeJwtPart(token, 0);
          const payload = decodeJwtPart(token, 1);
          ctx.log.info(
            `${PREFIX} alg=${header.alg} kid=${header.kid} sub=${payload.sub} aud=${payload.aud}`,
          );

          // 2. Exchange. AssumeRoleWithWebIdentity is an unsigned operation, so
          //    the client needs no credentials of its own.
          const runId = String(payload.kici_run_id);
          const sts = new STSClient({ region: REGION });
          let creds;
          try {
            const out = await sts.send(
              new AssumeRoleWithWebIdentityCommand({
                RoleArn: ROLE_ARN,
                RoleSessionName: `kici-e2e-${runId.slice(0, 8)}`,
                WebIdentityToken: token,
                DurationSeconds: 900,
              }),
            );
            creds = out.Credentials;
          } catch (err) {
            const e = err as { name?: string; message?: string };
            const message = String(e.message ?? err)
              .split(token)
              .join('<id-token>');
            ctx.log.error(`${PREFIX} assume=failed code=${e.name ?? 'unknown'} message=${message}`);
            throw err;
          }
          if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
            throw new Error('AssumeRoleWithWebIdentity returned no credentials');
          }
          ctx.log.info(`${PREFIX} assume=ok`);

          // 3. Put + get with the role credentials.
          const s3 = new S3Client({
            region: REGION,
            credentials: {
              accessKeyId: creds.AccessKeyId,
              secretAccessKey: creds.SecretAccessKey,
              sessionToken: creds.SessionToken,
            },
          });
          const key = `e2e/${runId}/probe.txt`;
          const body = `kici aws-oidc probe run=${runId} ts=${new Date().toISOString()}\n`;
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
          const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
          const readBack = await got.Body?.transformToString();
          if (readBack !== body) {
            throw new Error(`probe object did not round-trip: got ${JSON.stringify(readBack)}`);
          }

          // 4. Delete, then prove the prefix is empty.
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
          const left = await s3.send(
            new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `e2e/${runId}/` }),
          );
          if ((left.KeyCount ?? 0) !== 0) {
            throw new Error(`${left.KeyCount} object(s) left under e2e/${runId}/`);
          }
          ctx.log.info(`${PREFIX} verdict=ok bucket=${BUCKET} key=${key} deleted=true`);
        }),
      ],
    }),
  ],
});
```

<!-- END GENERATED: oidc-aws-workflow -->

On the AWS side, create an IAM OpenID Connect identity provider whose URL is
your orchestrator's issuer and whose audience is `sts.amazonaws.com`, then
attach the [worked trust policy](#a-worked-aws-trust-policy) to the role. When
the issuer URL carries a path, the condition keys carry it too:
`orch.example.com/kici:sub`, not `orch.example.com:sub`.

## ID-token claims and cloud trust policies

A cloud provider's OIDC trust policy decides which builds may assume a role. The
token below is what your policy matches on, so read this section before you
write one.

### The claim set

| Claim                         | Value                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`                         | Your orchestrator's provenance issuer                                                                                                                                         |
| `aud`                         | The audience you asked for                                                                                                                                                    |
| `sub`                         | The build identity — see the two shapes below                                                                                                                                 |
| `repository`                  | `owner/repo` the run acted on                                                                                                                                                 |
| `workflow_repository`         | `owner/repo` that defines the workflow. For an organization-wide workflow, `repository` names the repository whose event started the run instead. Otherwise the two are equal |
| `ref`                         | The branch or tag the run PRESENTS. For a pull request this is the **base** branch, not the contributor's branch                                                              |
| `base_ref`                    | The same value as `ref`, named the way GitHub Actions names it                                                                                                                |
| `head_ref`                    | The pull request's HEAD branch; `''` for a non-PR run                                                                                                                         |
| `head_repository`             | `owner/repo` of the pull-request HEAD — the contributor's fork for a fork PR; `''` for a non-PR run                                                                           |
| `is_fork`                     | `'true'`, `'false'`, or `'unresolved'`                                                                                                                                        |
| `event_name`                  | The event that started the run (`push`, `pull_request:opened`, `schedule`, …)                                                                                                 |
| `trust_tier`                  | The resolved trust tier of the triggering actor, or `'unresolved'`                                                                                                            |
| `actor`                       | Provider login of the triggering actor                                                                                                                                        |
| `sha`                         | The run's commit                                                                                                                                                              |
| `workflow_ref`                | `<workflow name>@<sha>`                                                                                                                                                       |
| `kici_run_id` / `kici_job_id` | The run and job this token was minted for                                                                                                                                     |
| `org_id`                      | Your organization id                                                                                                                                                          |
| `orchestrator_id`             | The orchestrator that ran the job                                                                                                                                             |
| `provider`                    | The source provider the run came from (`github`, `gitlab`, …)                                                                                                                 |
| `source_origin`               | `triggered` for a webhook-driven run; `run-remote` when the run executed an uploaded working tree (`kici run remote`)                                                         |
| `attestation_origin`          | `live` when the token was minted during the job; `deferred` or `offline-backfill` when it was minted later for a frozen statement                                             |
| `statement_hash`              | The hash of the frozen statement a deferred token is bound to; `null` for a live token                                                                                        |

Every claim in the table is **always present**. A value the run did not resolve
is `''`, `'unresolved'` or `null`, never omitted and never guessed. That matters: an
absent claim makes a `StringEquals` condition pass, which would silently remove
a constraint you wrote expecting it to be enforced.

### The two `sub` shapes

```
push, tag, schedule, …     repo:<owner/repo>:ref:<ref>:workflow:<workflow name>
pull request, review       repo:<owner/repo>:pull_request
```

The pull-request shape carries **no ref segment**, mirroring GitHub Actions. A
pull request's `ref` is its base branch. So a ref-bearing subject would be
identical for a fork pull request targeting `main` and a trusted push to `main`.
A policy pinning that subject would hand your cloud role to any contributor who
opened a pull request running the same workflow.

For an [organization-wide workflow](./global-workflows.md), `sub` names the
repository whose event started the run, not the repository that defines the
workflow. For any other event, the `:workflow:` segment carries only the workflow name,
so a source repository with a same-named workflow of its own presents the same
`sub`. For a pull request, `sub` carries no workflow segment at all, so every
pull-request workflow of the source repository presents the same `sub`. A
trust policy that must tell the workflow's code apart from the source
repository's code should also condition on `workflow_repository`.

**A re-run keeps the shape of the run it repeats.** Re-running a pull-request
run presents `repo:<owner/repo>:pull_request`, because it rebuilds the same
commit from the same source. Its `event_name` claim still reads `rerun` — that
claim says what started the run, while `sub` says which identity the run
presents. A policy that pins the branch-shaped subject therefore does not match
a re-run of a pull request, which is the same protection the first run gets.

### A worked AWS trust policy

Pin `sub`, and pin the fork context too. `sub` alone tells you a pull request
ran; it does not tell you whose code ran.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/orch.example.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "orch.example.com:aud": "sts.amazonaws.com",
          "orch.example.com:sub": "repo:acme/app:ref:main:workflow:upload",
          "orch.example.com:is_fork": "false",
          "orch.example.com:head_repository": "acme/app",
          "orch.example.com:trust_tier": "trusted"
        }
      }
    }
  ]
}
```

This grants the role only to a run on `main` in `acme/app`, from code in that
same repository, triggered by an actor your orchestrator resolved as trusted.
A fork pull request fails on every one of the extra conditions, and a run whose
context did not resolve fails too — `'unresolved'` matches none of them, so the
policy fails closed.

To let a same-repo pull request assume the role, add a second statement pinning
`"sub": "repo:acme/app:pull_request"` alongside `"is_fork": "false"` and
`"head_repository": "acme/app"`.

### Migrating an existing policy

If you already pin a ref-bearing `sub` for pull-request runs, that policy stops
matching once you upgrade — which is the fix, because it was matching runs it
should not have. Move it to `repo:<owner/repo>:pull_request` plus the fork
conditions above. The same move covers a re-run of a pull request, which
presents the pull-request subject too.

## See also

- [Build provenance and attestations](./provenance.md) — `ctx.attestProvenance`
  builds on the identity token this page mints.
- [Private registries](./private-registries.md) — registry auth for installs,
  and where an exchanged Cloudsmith token fits.
- [SDK runtime reference](./sdk/runtime.md) — the `ctx.kici.oidc.token` step
  API in full.
- [Signing keys](../operator/orchestrator/signing-keys.md) — provisioning and
  rotating the key that signs these tokens.
- [Network requirements](../operator/network-requirements.md) — what the
  exchanging service must reach.
