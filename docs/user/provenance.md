---
title: Build provenance and attestations
description: Generate and verify signed SLSA provenance for the artifacts your workflows build
---

Build provenance is a signed, verifiable statement of **what produced an
artifact** — the source repository, commit, ref, workflow path, and builder that
ran. When a workflow step attests an artifact, KiCI records that statement,
signs it, and makes it retrievable so anyone can later prove the artifact came
from a specific KiCI run and was not swapped along the way.

This is the same idea behind supply-chain attestation systems like
[SLSA](https://slsa.dev/spec/v1.0/provenance): a downstream consumer (a release
gate, a security audit, a `"show me the provenance"` request) can verify the
artifact's origin without trusting the person who handed it over.

## What an attestation contains

An attestation is a self-contained bundle holding three things:

- An **in-toto SLSA v1.0 statement** describing the build: the subject artifact
  (name + content digest) and the provenance predicate (source repository,
  commit, ref, workflow, run/job identifiers, timestamps).
- A **[DSSE](https://github.com/secure-systems-lab/dsse) signature** over that
  statement, made with an ephemeral signing key generated for the run.
- A short-lived **OIDC identity token** issued by your **orchestrator** that
  binds the signature to the build identity. The token's identity claims
  (`repository`, `ref`, `sha`, run/job ids) are derived by the orchestrator from
  the run itself — a step cannot forge them.

The orchestrator owns the provenance root of trust: it holds its own long-lived
ES256 signing key, mints and signs the identity token **locally** from its own
run records, and publishes its own OIDC discovery + public key set (JWKS). Builds
therefore produce verifiable provenance with **no dependency on the hosted KiCI
platform** — the availability, sovereignty, and air-gap story all follow from
this.

Because the bundle carries the identity token and the public signing key, it is
**offline-verifiable**: a verifier checks it against the orchestrator's published
signing keys with no per-attestation online lookup.

## Attesting an artifact in a workflow

Call `ctx.attestProvenance({ subject })` from a step after you have produced the
artifact:

```typescript
import { workflow, job, step } from '@kici-dev/sdk';

export default workflow('release', {
  on: { push: { branches: ['main'] } },
  jobs: [
    job('publish', {
      steps: [
        step('build', async (ctx) => {
          await ctx.$`npm pack`;
        }),
        step('attest', async (ctx) => {
          const result = await ctx.attestProvenance({
            subject: { name: 'my-pkg-1.2.3.tgz', path: 'my-pkg-1.2.3.tgz' },
          });
          ctx.log.info(`Attestation stored at ${result.storageKey}`);
        }),
      ],
    }),
  ],
});
```

The **subject is caller-supplied** — you name the artifact and give KiCI either a
path or a precomputed digest:

- `{ name, path }` — a path relative to the step working directory. KiCI reads
  the file and computes its SHA-256 digest.
- `{ name, digest }` — a precomputed digest. For a container image, pass the OCI
  manifest digest your build tool emitted:

  ```typescript
  await ctx.attestProvenance({
    subject: { name: 'ghcr.io/acme/app', digest: { sha256: '<manifest-digest>' } },
  });
  ```

The identity token is fetched and masked in logs automatically — you never
handle it. The call returns `{ storageKey, subjectDigest, bundleMediaType }`
identifying the stored bundle.

`ctx.attestProvenance` is only available inside a running job step; calling it
outside one rejects with a clear error. `kici run --local` runs are supported:
the offline local dev plane signs with a dev identity under the
clearly-non-production issuer `kici-local`, and those bundles verify against a
trust root exported with `kici local trust-root`.

### Requesting a raw identity token

`ctx.attestProvenance` builds on a lower-level primitive you can call directly
when you need the identity token for a different tool:

```typescript
step('mint', async (ctx) => {
  const { token, expiresIn } = await ctx.kici.oidc.token({ audience: 'sigstore' });
  ctx.log.info(`Got an ID token valid for ${expiresIn}s`);
  // Hand `token` to a tool that exchanges it with a service trusting the issuer.
});
```

The token is a short-lived (about 10 minutes) signed JWT scoped to the current
run and job. Its identity claims (`repository`, `ref`, `sha`, `kici_run_id`,
`kici_job_id`) are derived by the orchestrator from the run context, so a step
cannot spoof them. The returned token value is automatically masked in step logs,
and the step never holds signing credentials — the orchestrator mints and signs
the token on the step's behalf from its own run records. Like `attestProvenance`,
it is only available inside a running job step.

## ID-token claims and cloud trust policies

A cloud provider's OIDC trust policy decides which builds may assume a role. The
token below is what your policy matches on, so read this section before you
write one.

### The claim set

| Claim                         | Value                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `iss`                         | Your orchestrator's provenance issuer                                                                            |
| `aud`                         | The audience you asked for                                                                                       |
| `sub`                         | The build identity — see the two shapes below                                                                    |
| `repository`                  | `owner/repo` the run acted on                                                                                    |
| `ref`                         | The branch or tag the run PRESENTS. For a pull request this is the **base** branch, not the contributor's branch |
| `base_ref`                    | The same value as `ref`, named the way GitHub Actions names it                                                   |
| `head_ref`                    | The pull request's HEAD branch; `''` for a non-PR run                                                            |
| `head_repository`             | `owner/repo` of the pull-request HEAD — the contributor's fork for a fork PR; `''` for a non-PR run              |
| `is_fork`                     | `'true'`, `'false'`, or `'unresolved'`                                                                           |
| `event_name`                  | The event that started the run (`push`, `pull_request:opened`, `schedule`, …)                                    |
| `trust_tier`                  | The resolved trust tier of the triggering actor, or `'unresolved'`                                               |
| `actor`                       | Provider login of the triggering actor                                                                           |
| `sha`                         | The run's commit                                                                                                 |
| `workflow_ref`                | `<workflow name>@<sha>`                                                                                          |
| `kici_run_id` / `kici_job_id` | The run and job this token was minted for                                                                        |
| `org_id`                      | Your organization id                                                                                             |

Every claim in the table is **always present**. A value the run did not resolve
is `''` or `'unresolved'`, never omitted and never guessed. That matters: an
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
          "orch.example.com:sub": "repo:acme/app:ref:main:workflow:deploy",
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
A fork pull request fails on all three of the extra conditions, and a run whose
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

While you migrate, `KICI_OIDC_LEGACY_PR_SUB=1` on the orchestrator restores the
old subject. It restores the collision with it, so treat it as a short bridge,
not a setting. See [deprecations](deprecations.md).

## Verifying an attestation

Verify a bundle with the `kici verify-attestation` command. It establishes the
full chain offline: the identity token verifies against the trusted issuer's
JWKS, the DSSE signature verifies against the bundled signing key, and the
statement's build context must match the token's identity claims (a mismatch is
a hard failure).

```bash
kici verify-attestation [artifact] --bundle <path-or-url> [--trust-root <url-or-file>]
```

### Which trust root do I use?

The trust root is **your orchestrator's provenance issuer** — the orchestrator
you `kici login` against, which owns the provenance signing key and publishes its
own JWKS. That is the **default**: omit `--trust-root` and the verifier checks the
bundle against your configured orchestrator automatically. There are three ways to
verify, and offline is always the primary one:

1. **Offline against a JWKS / trust-root file (air-gap)** — export the
   `{ issuer, jwks }` file once with `kici-admin signing-key export --public` and
   verify against it with `--trust-root <file>`. No network needed at verify time.
2. **Directly online against your orchestrator** — the default: the verifier
   resolves your orchestrator's discovery → JWKS. You can also POST a bundle to
   the orchestrator's native `POST /v1/verify-attestation` endpoint for a verdict
   against its live keys (fresh rotations / revocations included).
3. **Against the hosted KiCI platform** — bundles produced before your
   orchestrator owned signing were signed by the hosted platform; those keep
   verifying forever. When no orchestrator is configured, the default falls back
   to the hosted platform's issuer so those historical bundles still verify with
   no flag.

You pass `--trust-root` to verify against a different environment or, most
commonly, an offline `{ issuer, jwks }` file for air-gapped checks.

### Why you supply it out-of-band

The verifier already resolves a sensible default, so why is naming the trust
root a supported step at all -- why not let the verifier read the issuer from
the token? Because the issuer named **inside** a token cannot be trusted. A
forged bundle could carry a token that names `iss: https://attacker.example`
_and_ bundle a key set that "verifies" it. That makes the whole signature chain
circular and self-attesting. The verifier
therefore pins to an issuer you supply out-of-band and checks the token against
_that_ — the bundle is verified against a key set you trust, not one it shipped
with. Naming the trust root is a security requirement, not a multiple-choice
question.

To override the default, supply the trusted issuer via `--trust-root`, in one of
two forms:

- **Online — an HTTPS issuer URL.** The verifier fetches
  `<url>/.well-known/openid-configuration`, reads its `issuer` and `jwks_uri`,
  and fetches the JWKS. The token's `iss` is pinned to the discovery document's
  `issuer`.
- **Offline — a self-contained trust-root file.** A local JSON file with the
  issuer and JWKS inlined, for air-gapped verification:

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

Pass an optional `[artifact]` to also digest-check the file against the
attestation subject — this is what binds the attestation to a specific set of
bytes. Omit it to verify the signatures and identity only. Use `--json` for a
machine-readable result. The command exits `0` when everything verifies and `1`
when it does not (or on an error such as a missing flag or unreachable trust
root).

```bash
# Default: verify against your configured orchestrator (no --trust-root needed):
kici verify-attestation ./dist/app.tgz --bundle ./app.tgz.kici.json

# Override the trust root to verify against a specific issuer:
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root https://platform.example/issuer

# Air-gapped: verify against a self-contained trust-root file:
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root ./kici-trust-root.json
```

The full flag reference is in the [CLI reference](./cli/notifications-and-diagnostics.md#kici-verify-attestation).

## Viewing attestations in the dashboard


## Browsing attestations across runs

The **Attestations** page (in the org sidebar) lists every build-provenance
attestation your organization has produced — not just one run's. It is the
supply-chain audit surface: look up "who built `sha256:…`?" by digest, or browse
and filter every attestation across all runs.


The status badge here is the **server-side verdict**, computed once when the
attestation was recorded (verify-at-ingest) — so the list stays fast at any
size. `verified` means the signature, build identity, and build context all
checked out against the provenance issuer; `failed` means verification ran and
the bundle did not pass; `unverifiable` means no verdict could be computed (no
provenance issuer configured, or its keys could not be read — not a forgery
signal); `pending` means the verdict has not been computed yet.

A `pending` row is one still waiting to be minted — the attestation was signed
at build time, but attaching its identity token has not completed yet. Those
rows carry a **Retry** button that asks your orchestrator to mint that run's
outstanding attestations immediately, and the page header offers **Retry
pending** to do the same across every pending run. Only one retry runs at a
time — the other retry buttons are unavailable until it finishes.

Retrying is safe to repeat while the mint is only temporarily unavailable: the
row stays pending and the next retry tries again. A mint that is definitively
rejected — for example the run's records are no longer there to bind the
attestation to — is terminal: the row stops being retried, and re-arming it is
an operator action (`kici-admin attestations retry --include-rejected`).

Opening a row leads to the **attestation detail page**:


## See also

- [SDK runtime reference](./sdk/runtime.md) — the `ctx.attestProvenance` and
  `ctx.kici.oidc.token` step APIs in full.
- [CLI reference](./cli/notifications-and-diagnostics.md#kici-verify-attestation) — every
  `kici verify-attestation` flag and exit code.
