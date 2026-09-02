---
title: Getting help
description: How to report a problem to KiCI and send the diagnostic context privately
---

When something goes wrong, the fastest path to a fix is a report that already
carries the context. This page covers what to try first, what to send, and how
to send it privately.

## Diagnose it yourself first

Two commands answer most problems without anyone else involved:

```bash
# Check your own setup: login, org, lock file, orchestrator, agent labels
kici doctor

# Look at the org's infrastructure: orchestrators, scalers, agents
kici diagnostics
```

`kici doctor` prints the next command to run for each problem it finds. Work
down its output before reporting — a stale lock file or an expired login is a
one-command fix.

If your workflow ran and failed, read its logs:

```bash
kici runs show <run-id>
kici runs logs <run-id>
```

[Common failures](./common-failures.md) covers the errors people hit most.

## Report a problem

When you cannot resolve it yourself, gather a diagnostic bundle:

```bash
kici report --run <run-id> --message "what you expected, and what happened"
```

The command writes a ZIP and prints its path and `sha256`. It sends nothing.
The bundle holds:

- your CLI, Node, and orchestrator versions,
- your redacted KiCI configuration,
- your project's workflow list and lock-file state,
- the failing run's detail and logs, when you pass `--run`,
- a collection report saying which of those the command could and could not
  read.

Open the file and read it. It is yours until you decide to share it.

### What gets redacted

KiCI removes known secret shapes before anything enters the bundle:

- API keys and access tokens (AWS, GitHub, Slack, KiCI agent tokens),
- `Authorization` headers and JSON web tokens,
- passwords inside connection URLs,
- private keys and encrypted-value blocks,
- values assigned to a secret-named key, such as `api_key=` or `password=`.

Configuration is redacted twice: an allowlist keeps only known-safe fields, and
the free-text scrubber runs over what remains.

**Redaction is best effort.** A secret in a format KiCI does not recognize can
survive it. Review the bundle before you share it. `--no-redact` turns
redaction off and prints a warning — use it only for a bundle you keep.

## Send it privately

Reports contain your data, so there is no public tracker for them. Add
`--upload` to send the bundle to KiCI directly:

```bash
kici report --run <run-id> --upload --message "matrix job hangs on macOS"
```

A defect in KiCI itself is different: if you can reproduce it without your own
data — the docs promise something the tool does not do — it belongs in the
public tracker instead. See [Reporting a discrepancy](./reporting-discrepancies.md).

The command prints a reference id. Quote it in any conversation about the
problem. The bundle goes straight from your machine to KiCI storage over a
one-time upload link — it never passes through the dashboard.

Add `--email` if you want a reply address attached to the report.

## Manage what you have sent

An upload is not permanent, and it is yours to revoke:

```bash
# See the reports you have uploaded
kici report list

# Delete an uploaded bundle
kici report withdraw <ref>
```

Uploaded bundles expire automatically after 90 days.

Anyone in your organization can upload a report. By default you see and
withdraw your own. A member with the `support:admin` permission can manage
every report in the organization, which is how an owner cleans up on behalf of
someone who has left.

## Reporting a security issue

Do not use `kici report` for a suspected vulnerability. Follow the disclosure
process in [SECURITY.md](https://github.com/kici-dev/kici-public/blob/main/SECURITY.md)
instead.

## See also

- [Common failures](./common-failures.md) — the errors people hit most, and their fixes
- [CLI reference](./cli-reference.md) — every `kici` command
- [Dashboard](./dashboard.md) — inspecting runs in the browser
