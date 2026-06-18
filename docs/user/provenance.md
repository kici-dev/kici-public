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
kici verify-attestation [artifact] --bundle <path-or-url> --trust-root <url-or-file>
```

You supply the trusted issuer out-of-band via `--trust-root` — the verifier
never trusts the issuer named inside the token. There are two forms:

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
# Verify a bundle against a deployed issuer, digest-checking the artifact:
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


## See also

- [SDK runtime reference](./sdk/runtime.md) — the `ctx.attestProvenance` and
  `ctx.kici.oidc.token` step APIs in full.
- [CLI reference](./cli-reference.md#kici-verify-attestation) — every
  `kici verify-attestation` flag and exit code.
