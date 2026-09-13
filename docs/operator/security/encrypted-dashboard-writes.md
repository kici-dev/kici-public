---
title: Encrypted dashboard writes
description: The encrypted dashboard-write posture, where the browser seals a secret or variable value to your orchestrator so the hosted control plane never sees the plaintext
---

The `encrypted` posture on the [dashboard-write policy](./dashboard-write-policy.md) keeps the web UI's value-entry form for the two plaintext operations (`secrets.set`, `variables.set`) while removing the hosted control plane from the plaintext path. When an operation is set to `encrypted`, the **browser encrypts the value to your orchestrator before it leaves the page**, and the control plane relays only opaque ciphertext.

This gives you dashboard UX for secret and variable entry with the same trust property you get from `kici-admin secret set`: the hosted control plane process never receives the plaintext value.

## How it works

Your orchestrator owns an X25519 encryption keypair. It generates the key at first boot (leader-gated across an HA cluster), wraps the private half with your orchestrator master key (`KICI_SECRET_KEY`), and stores it in its own database — the same at-rest posture as your scoped secrets. The private key never leaves your orchestrator.

The orchestrator publishes the **public** half at its `.well-known/jwks.json` endpoint (an OKP/X25519 key marked `use: "enc"`, served alongside any build-provenance signing keys). When a workflow author sets a secret or variable value in the dashboard under the `encrypted` posture:

1. The browser fetches the orchestrator's encryption public key and **displays the source URL** it fetched from, next to the value field, at all times.
2. On submit, the browser seals the value: it generates an ephemeral X25519 keypair, performs ECDH against the orchestrator public key, derives an AES-256-GCM key, and encrypts the value. Only the sealed envelope (ephemeral public key + ciphertext + the key id) is sent — never the plaintext.
3. The control plane relays the sealed envelope to your orchestrator unchanged.
4. Your orchestrator decrypts the envelope with its private key and re-encrypts the value at rest into its secret store — the same storage path a `kici-admin secret set` takes.

## Two trust tiers

Trust in the encryption key comes from **where the browser fetched it**, and the dashboard always shows that source URL. There are two tiers:

### Convenient tier (default, zero configuration)

The browser fetches the encryption key through the control plane. The control plane relays only ciphertext thereafter, so it no longer sees plaintext in normal operation — a real improvement over `permissive` (ciphertext instead of plaintext through the control plane) with zero setup. The displayed source URL is informational: this tier does not defend against a fully-active control plane that tampers with the key at first contact. It is strictly better than `permissive`, and it is the right default for most teams.

### Verified tier (opt-in)

You expose your orchestrator's `.well-known` endpoint on an origin you control (the same origin that serves build-attestation discovery if `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` is set — the Verified tier itself needs no attestation setup), and configure that origin as the verified issuer. The dashboard then fetches the encryption key **directly from your origin, bypassing the control plane** — TLS to your own domain is the trust root, exactly as `kici verify-attestation` trusts your orchestrator's `.well-known`. The displayed source URL is your own origin and is genuinely verifiable. This tier is airtight against an active, malicious control plane, with no per-user or per-browser work — you did the out-of-band setup once by exposing the endpoint.

The Verified tier requires your orchestrator's `.well-known` endpoint to be reachable from the operator's browser (internet- or VPN-reachable). The orchestrator serves the cross-origin headers that browsers require on those endpoints, so no proxy configuration is needed on your side — but a `.well-known` endpoint that only your servers can reach will block every encrypted write from the dashboard. That reachability requirement is why the tier is opt-in and cannot be the default.

Configure the origin as a fleet-wide setting:

```bash
kici-admin cluster-settings set --dashboard-verified-issuer https://orch.example.com
kici-admin cluster-settings show          # confirm the stored value
kici-admin cluster-settings reset --dashboard-verified-issuer   # back to the default
```

The value must be an absolute `http(s)` origin. When it is unset, the Verified tier is not offered and the Convenient tier is used. Setting a build-attestation issuer does not enable this tier: configuring attestations never changes how the dashboard fetches encryption keys.

The two settings are independent. Your orchestrator publishes the dashboard-encryption key at `.well-known/jwks.json` whenever it has one, whether or not `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` is set — so the Verified tier needs nothing from build attestations. (The `.well-known/openid-configuration` discovery document is still the build-attestation issuer's, and is served only when that variable is set; the Verified tier does not read it, because the dashboard fetches the JWKS URL directly.) `kici-admin cluster-settings set --dashboard-verified-issuer` fetches the JWKS after storing the value and warns if no encryption key is published there, so a wrong origin or a missing key surfaces at set time rather than as a blocked write later.

### When the policy cannot be determined

If the dashboard cannot determine an operation's posture — while it is still
loading, or when the lookup fails — value entry is blocked rather than sent. An
undetermined posture might really be `encrypted`, so submitting would risk
sending a plaintext value through the hosted control plane. Use the command-line
equivalent shown in the form while the lookup is failing.

### Where values are entered

Secret and variable values are always entered on a page that names one
orchestrator, because a value is encrypted to that orchestrator's key.
Organization-wide secret and context links resolve to that orchestrator
automatically when only one is connected, and otherwise ask which one you mean.

## Fail-closed

The `encrypted` posture never silently falls back to sending plaintext through the control plane:

- If the browser cannot fetch or verify the encryption key, the value form is disabled and the UI points you at `kici-admin secret set` — it does not send plaintext.
- The orchestrator refuses a plaintext value for an `encrypted`-posture operation (defense in depth against a misbehaving or outdated client), returning a structured error rather than storing it.
- An envelope sealed to an unknown key, or one that fails to decrypt, is refused — never stored.

## Key rotation

Rotating the encryption key generates a new active key and marks the previous one rotated-out. The rotated-out key drops out of the published JWKS immediately, so every new seal uses the new key — but your orchestrator keeps the old key's private half, so a value a browser already sealed to the previous key id still decrypts. Nothing is lost mid-rotation.

```bash
kici-admin dashboard-encryption-key show      # active kid, public JWK, both JWKS URLs
kici-admin dashboard-encryption-key list      # every key on record with its status
kici-admin dashboard-encryption-key rotate    # mint a new active key
```

`rotate` prompts before it mints; pass `--dry-run` to preview or `--yes` to skip the prompt in a script. All three read the orchestrator database directly, so they need `KICI_DATABASE_URL` (or `--database-url`); `rotate` also needs `KICI_SECRET_KEY`, which wraps the new private key.

The active key is generated automatically the first time an orchestrator boots with `KICI_SECRET_KEY` set — in an HA cluster the generation is leader-gated, so exactly one key is minted no matter how many nodes start at once. You only need `rotate` for a deliberate rotation or a suspected compromise.

## See also

- [Dashboard-write policy](./dashboard-write-policy.md) — the per-operation policy the `encrypted` posture is part of.
