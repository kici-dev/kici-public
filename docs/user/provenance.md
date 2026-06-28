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
- A short-lived **OIDC identity token** issued by the KiCI platform that binds
  the signature to the build identity. The token's identity claims
  (`repository`, `ref`, `sha`, run/job ids) are derived by the platform from the
  run itself — a step cannot forge them.

Because the bundle carries the identity token and the public signing key, it is
**offline-verifiable**: a verifier checks it against the platform's published
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

`ctx.attestProvenance` is only available inside a running job step. Calling it
during local execution rejects with a clear error.

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
`kici_job_id`) are derived by the platform from the run context, so a step cannot
spoof them. The returned token value is automatically masked in step logs, and
the step never holds platform credentials — the request is relayed through the
orchestrator, which mints the token on the step's behalf. Like
`attestProvenance`, it is only available inside a running job step.

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

The trust root is the **KiCI platform's provenance issuer** — the same hosted
KiCI platform you `kici login` against. KiCI attestations are issued by, and
verified against, that one issuer; there are no competing "roots" to choose
between. So the answer to "shouldn't I just use KiCI as the trust root?" is yes
— and that's the **default**: omit `--trust-root` and the verifier checks the
bundle against the hosted KiCI platform automatically. You only pass
`--trust-root` to verify against a different environment or, more commonly, an
offline `{ issuer, jwks }` file for air-gapped checks.

### Why you supply it out-of-band

Given there's a single issuer, why pass it at all instead of letting the
verifier read it from the token? Because the issuer named **inside** a token
cannot be trusted: a forged bundle could carry a token that names
`iss: https://attacker.example` _and_ bundle a key set that "verifies" it,
making the whole signature chain circular and self-attesting. The verifier
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
# Default: verify against the hosted KiCI platform (no --trust-root needed):
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

The full flag reference is in the [CLI reference](./cli-reference.md#kici-verify-attestation).

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

Opening a row leads to the **attestation detail page**:


## See also

- [SDK runtime reference](./sdk/runtime.md) — the `ctx.attestProvenance` and
  `ctx.kici.oidc.token` step APIs in full.
- [CLI reference](./cli-reference.md#kici-verify-attestation) — every
  `kici verify-attestation` flag and exit code.
