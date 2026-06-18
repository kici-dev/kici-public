# Security policy

We take security reports seriously and aim to respond quickly. This page describes what's in scope, how to reach us, and what to expect after you file a report.

## Supported versions

KiCI is pre-1.0. Security fixes land on the latest minor of the `0.1.x` line. Older minors are not patched — please upgrade to the latest release before reporting an issue tied to old code.

| Version line | Security fixes |
| ------------ | -------------- |
| `0.1.x`      | yes (latest)   |
| `< 0.1.0`    | no             |

Once 1.0 ships, the supported-version policy will be revised — likely "current major + previous major for N months".

## How to report

Please file a private [GitHub Security Advisory](https://github.com/kici-dev/kici-public/security/advisories/new) with a description of the issue, steps to reproduce, and (if you have one) a proof of concept. We'll acknowledge within **7 business days** and provide a fix-or-mitigate plan within **30 days** for high-severity issues.

If you prefer encrypted communication, mention "PGP" in the advisory and we'll coordinate a key exchange before you share details. We don't publish a fixed-URL PGP key by default — easier to coordinate on demand than to maintain a rotation cycle for an audience that mostly doesn't need it.

For non-security bugs, please file a regular [GitHub issue](https://github.com/kici-dev/kici-public/issues) instead.

## What's in scope

In scope for this policy:

- Packages we publish to npmjs.org: `@kici-dev/sdk`, `@kici-dev/compiler`, `@kici-dev/core`, `@kici-dev/engine`, `@kici-dev/shared`, `@kici-dev/orchestrator`, `@kici-dev/agent`, `kici`, `kici-admin`.
- The container images we publish to `quay.io/kici-dev/` (`kici-orchestrator`, `kici-agent`). Each release's manifest-list digests (and the npm tarball integrity hashes) are published on the [release artifacts page](docs/operator/distribution/release-artifacts.md) so you can pin and verify exactly what you pull.

Out of scope (covered by different policies or by the deployer themselves):

- **Customer-deployed instances of the orchestrator + agent.** These are governed by your own security program — your deployment, your configuration, your responsibility. We're happy to help triage a finding that's specific to a customer deployment if you reach out via a Security Advisory.
- **The public dashboard at `app.kici.dev` and the hosted relay.** These run on our infrastructure and have their own security boundary. Reports for those are also welcome via the same Security Advisory channel; we'll route them internally.

## What we ask of you

- Give us a reasonable window to fix the issue before public disclosure — we use a **90-day default**, negotiable for findings that need longer or shorter windows.
- Don't pivot. If you find one bug, please don't escalate it to extract data, access other users' resources, or modify state beyond what's needed to demonstrate the issue.
- Don't run automated scanning against `app.kici.dev` or any KiCI-operated infrastructure.

## What you get from us

- Acknowledgement within 7 business days.
- Status updates while we investigate.
- Public credit (with your name or handle) in the release notes for the patched version, unless you ask to stay anonymous.

We don't run a bug bounty pre-revenue. Public acknowledgement is the only reward we can offer right now — we're transparent about that.

## Coordinated disclosure

For findings that warrant a CVE, we'll work with you to coordinate disclosure timing, publish the [GitHub Security Advisory](https://github.com/kici-dev/kici-public/security/advisories), and credit you in the advisory. The default is to publish the advisory simultaneously with the patched release.

## See also

- [.well-known/security.txt](./.well-known/security.txt) — RFC 9116 machine-readable version of this policy.
- [LICENSES.md](LICENSES.md) — per-package licensing (relevant when forking or self-hosting).
