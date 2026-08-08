---
title: Provenance signing keys
description: Provision, rotate, and back up the orchestrator's build-provenance signing key
---

Your orchestrator is the root of trust for build provenance. It holds a
long-lived ES256 signing key, mints and signs each attestation's identity token
locally from its own run records, and publishes its own OIDC discovery + public
key set (JWKS). Builds therefore produce verifiable provenance with no dependency
on the hosted KiCI platform.

This page covers provisioning the key, choosing a custody backend, the discovery
endpoints, rotation and revocation, and the backup + loss-recovery runbook.

## Enabling orchestrator-owned signing

Set the orchestrator's provenance issuer to the public base URL where the
orchestrator's `.well-known` endpoints are reachable:

```bash
KICI_ORCHESTRATOR_PROVENANCE_ISSUER=https://orchestrator.example.com
```

When this is set, orchestrator-owned signing is **on**: on first use the
orchestrator generates (or loads) its signing key, mints and signs identity
tokens locally, verifies attestations at ingest against its own keys, and serves:

- `GET /.well-known/openid-configuration` — OIDC discovery (`issuer`, `jwks_uri`,
  `id_token_signing_alg_values_supported: ["ES256"]`).
- `GET /.well-known/jwks.json` — the public key set (public halves only, safe to
  expose). This is what makes offline verification work.
- `POST /v1/verify-attestation` — a native online verify endpoint: submit a
  bundle and get a verdict against the orchestrator's live keys.

The issuer URL must be **stable and durable** — it is the identity of your
cluster's provenance. Changing it re-roots trust for future attestations.

In a clustered deployment every node reads the one cluster key from the shared
database, so any node's public endpoint serves the same JWKS.

## Custody backends

Choose how the private key is held with `KICI_ORCHESTRATOR_SIGNER_KIND`:

| Kind           | Where the private key lives                                                                                                                                                                                                                    | When to use                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `db` (default) | Encrypted at rest in the orchestrator database, wrapped with your `KICI_SECRET_KEY` master key (the same posture as scoped secrets — the master key lives in your environment, never in the database, so a database backup alone cannot sign). | The simplest option; HA, backup/restore, and air-gap all work out of the box.                                                                 |
| `aws-kms`      | AWS KMS (an asymmetric ECC_NIST_P256 key). The private key never leaves KMS.                                                                                                                                                                   | You already run KMS and want hardware-backed custody. Set `KICI_ORCHESTRATOR_KMS_KEY_ARN`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`. |
| `command`      | Anywhere your signing command can reach (GCP KMS, Azure Key Vault, Vault transit, a PKCS#11 HSM — anything).                                                                                                                                   | You want a KMS/HSM KiCI does not ship a built-in for. Set `KICI_ORCHESTRATOR_SIGNER_COMMAND`.                                                 |

### The `command` signer contract

The orchestrator invokes your command with a subcommand on `argv`:

- `<command> get-public-jwk` — write the public key as a JWK JSON object (an EC
  P-256 key) to stdout.
- `<command> sign` — read the base64 of the bytes to sign from stdin, write the
  base64 of the JOSE-raw (`r||s`, 64-byte) ES256 signature to stdout.

The command is operator-controlled configuration, never attacker-controlled — the
same trust level as any other orchestrator setting. This is a stable extension
point: with it you get any KMS/HSM backend with no per-cloud code in KiCI.

## The private key is non-exportable by design

There is **no export of private key material and no import**. For `db` custody the
private key is generated in encrypted-at-rest custody and imported non-extractable
into the running process; for `aws-kms` / `command` custody it never exists inside
KiCI at all. Only the **public** key set is exportable. This is both simpler and
strictly more secure — see the loss-recovery runbook below for why losing the
private key is only a routine rotation, not data loss.

## Managing keys

Use `kici-admin signing-key`:

```bash
kici-admin signing-key list                     # kid / status / created_at
kici-admin signing-key generate                 # generate the initial db key (no-op if one is active)
kici-admin signing-key rotate                   # generate a new db key and activate it (old → retiring)
kici-admin signing-key retire <kid>             # move a retiring key to retired (stays in the JWKS)
kici-admin signing-key revoke <kid> --reason r  # distrust a compromised key (removed from the JWKS)
kici-admin signing-key export --public --out f  # write the { issuer, jwks } backup / air-gap artifact
```

### Key lifecycle

- **active** — the one current signing key.
- **retiring** — just rotated out; still served in the JWKS during the overlap so
  in-flight short-lived tokens minted just before rotation still verify.
- **retired** — no longer signs, but its public half **stays in the JWKS
  indefinitely** so every historical attestation it signed keeps verifying.
- **revoked** — compromised; **removed** from the JWKS. Everything it signed
  becomes unverifiable. Revoke only a genuinely compromised key.

## Backup and loss recovery

The catastrophe boundary is the **public key set, not the private key**.
Verification only ever needs the public key for the `kid` that signed a bundle,
and an attestation is signed once and never re-signed. Therefore:

- **Losing the private key forces a routine rotation, not data loss.** Generate a
  fresh key (`kici-admin signing-key rotate`); its public half is appended to the
  retained set and the old `kid` goes `retired` and stays in the JWKS, so all of
  its history keeps verifying. The only cost is a new `kid` for future
  attestations.
- **The only irreversible loss is losing the accumulated public JWKS** (for
  example, total database loss with no backup) — historical attestations then
  become unverifiable forever.

So back up the **public JWKS**, which is the easy asset: it is non-secret, so it
replicates freely. Three independent survival channels:

1. **Database backup** includes the signing-keys table (public + encrypted
   private material). Fold it into your regular database backup runbook.
2. **`kici-admin signing-key export --public`** emits the `{ issuer, jwks }` file
   — the recommended out-of-band backup, which also doubles as the air-gap verify
   trust-root artifact (one artifact, two jobs). Being non-secret, copy it
   anywhere (version control, object storage, paper).
3. Keep the **master key** (`KICI_SECRET_KEY`) as an out-of-band operator
   responsibility (same as scoped secrets). KMS / external-signer custody removes
   even that concern — the private key never exists outside the KMS/HSM.

## Verifying against your orchestrator

`kici verify-attestation` defaults its trust root to the configured orchestrator,
so the common case needs no flag. For air-gapped verification, export the
trust-root file once and pass it with `--trust-root <file>`:

```bash
kici-admin signing-key export --public --out kici-trust-root.json
kici verify-attestation ./dist/app.tgz --bundle ./app.tgz.kici.json \
  --trust-root ./kici-trust-root.json
```

See [build provenance and attestations](../../user/provenance.md) for the full
verify story and the three verification paths.
