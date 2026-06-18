---
title: Dashboard-write policy
description: Per-orchestrator, per-operation policy that decides which dashboard write actions stay on the dashboard and which become CLI-only
---

The orchestrator decides, per operation, whether a mutating dashboard action stays on the web UI or becomes **CLI-only** (reachable solely through `kici-admin` against the orchestrator's HTTP admin API). The policy is configured by the orchestrator operator and is read by three layers — the dashboard (for rendering), the SaaS control plane (for HTTP route gating), and the orchestrator itself (for defense-in-depth handler enforcement). All three layers read the same operation registry.

The default at first boot is **permissive**: every operation is enabled. Small teams onboard with the dashboard doing everything they expect a CI control plane to do. Customers preparing for SOC2 or running regulated workloads ratchet specific operations off as their compliance posture demands. There is no "all-or-nothing" switch — every operation flips independently.

## The operation registry

Every mutating dashboard action maps to exactly one `DashboardWriteOperation`. The orchestrator ships with **24 operations** today, grouped into eight categories and three sensitivity buckets:

| Category          | Operation                              | Sensitivity | `kici-admin` equivalent                                     |
| ----------------- | -------------------------------------- | ----------- | ----------------------------------------------------------- |
| **Secrets**       | `secrets.set`                          | plaintext   | `kici-admin secret set`                                     |
|                   | `secrets.delete`                       | authority   | `kici-admin secret delete`                                  |
|                   | `secrets.scope.create`                 | authority   | `kici-admin secret scope create`                            |
|                   | `secrets.scope.rename`                 | authority   | `kici-admin secret scope rename`                            |
|                   | `secrets.scope.delete`                 | authority   | `kici-admin secret scope delete`                            |
| **Variables**     | `variables.set`                        | plaintext   | `kici-admin variable set`                                   |
|                   | `variables.delete`                     | authority   | `kici-admin variable delete`                                |
| **Environments**  | `environments.create`                  | authority   | `kici-admin environment create`                             |
|                   | `environments.update`                  | authority   | `kici-admin environment set-policy`                         |
|                   | `environments.test_access.set`         | authority   | `kici-admin environment set-policy --allow-local-execution` |
|                   | `environments.delete`                  | authority   | `kici-admin environment delete`                             |
| **Bindings**      | `environments.bindings.set`            | authority   | `kici-admin environment bind`                               |
|                   | `environments.source_overrides.set`    | authority   | `kici-admin environment source-override set`                |
|                   | `environments.source_overrides.delete` | authority   | `kici-admin environment source-override delete`             |
| **Held runs**     | `held_runs.approve`                    | dispatch    | `kici-admin runs approve`                                   |
|                   | `held_runs.reject`                     | dispatch    | `kici-admin runs reject`                                    |
| **DLQ**           | `event_dlq.retry`                      | dispatch    | `kici-admin event-dlq retry`                                |
|                   | `event_dlq.discard`                    | dispatch    | `kici-admin event-dlq discard`                              |
| **Registrations** | `registration.disable`                 | dispatch    | `kici-admin registration disable`                           |
|                   | `registration.delete`                  | dispatch    | `kici-admin registration delete`                            |
| **Topology**      | `global_workflows.update`              | dispatch    | `kici-admin org-settings global-workflows set`              |
|                   | `backends.sync`                        | dispatch    | `kici-admin backend sync`                                   |
|                   | `backends.sync_one`                    | dispatch    | `kici-admin backend sync --one`                             |
|                   | `backends.test`                        | dispatch    | `kici-admin backend test`                                   |

The **sensitivity** bucket describes the threat each operation participates in when routed through the dashboard:

- `plaintext` — the operation carries a customer-supplied plaintext value (a secret value, a variable value) that traverses the control plane's process memory on its way to the orchestrator. Disabling these routes the value through `kici-admin` (operator's machine → orchestrator HTTP admin API) and the control plane never sees the plaintext.
- `authority` — the operation reshapes the orchestrator's resolution tree or RBAC posture (environment CRUD, bindings, scope rename / delete). No plaintext, but the action's authority is the operator's, not the dashboard user's.
- `dispatch` — the operation releases or cancels execution (held-run approve / reject, DLQ retry / discard, registration disable / delete, scaler topology). Routing dispatch through `kici-admin` keeps the dispatch decision on the operator's side of the trust boundary.

## Who can flip the switches

`kici-admin` only. The policy lives in the orchestrator's database and mutates through the orchestrator's HTTP admin API; the dashboard renders the current state read-only and links to the canonical commands. **The dashboard cannot change the policy itself** — that's the point. If the dashboard could flip switches, a compromised control-plane process could flip every disabled operation back to permissive and exfiltrate. The CLI is the operator-side trust root for policy decisions.

The orchestrator's RBAC for admin tokens (see [Two-layer RBAC](./rbac-two-layers.md)) gates the `kici-admin org-settings dashboard-writes` subcommand on the `org-settings.write` permission — the same permission that gates other orchestrator-level configuration.

## Managing the policy

### Show the full policy

```bash
kici-admin org-settings dashboard-writes show
```

Prints every operation grouped by category, the current state (`enabled` or `disabled`), and the `kici-admin` equivalent for each. Two filtering flags reduce the output to a category or sensitivity bucket:

```bash
kici-admin org-settings dashboard-writes show --category=Secrets
kici-admin org-settings dashboard-writes show --sensitivity=plaintext
```

### Disable individual operations

```bash
kici-admin org-settings dashboard-writes set --op secrets.set=false
kici-admin org-settings dashboard-writes set --op secrets.set=false --op variables.set=false
```

Multiple `--op <name>=<bool>` flags are accepted in one call. The CLI prints a diff of what's about to change and refuses if any operation name is unknown.

### Disable a whole category or sensitivity bucket

```bash
kici-admin org-settings dashboard-writes set --category=Secrets --enabled=false
kici-admin org-settings dashboard-writes set --sensitivity=plaintext --enabled=false
```

`--category` and `--sensitivity` are convenience flags that expand to the equivalent `--op` list before the database update — the underlying storage only knows individual operations. The CLI prints the expanded set before applying so the operator sees exactly which operations they are touching.

### Reset to permissive

```bash
kici-admin org-settings dashboard-writes reset
```

Erases every override; every operation flips back to the permissive default.

## Recommended postures

These are starting points. Every operator should flip switches based on their own threat model and compliance posture.

### Small team, no compliance requirement

Keep the permissive default. The dashboard works the way most CI control planes work, and the trust model is identical to a typical SaaS CI vendor.

### SOC2 preparation, internal customers

Disable the two `plaintext` operations:

```bash
kici-admin org-settings dashboard-writes set --sensitivity=plaintext --enabled=false
```

Effect: secret values and variable values enter the orchestrator only through `kici-admin secret set` and `kici-admin variable set`. The SaaS control plane never receives those plaintext values, so a control-plane compromise cannot exfiltrate them during the breach window. Secret names, scopes, environment bindings, and every read path remain on the dashboard.

The CLI exposes five input modes (interactive prompt, stdin pipe, file, environment variable, argv) so ops engineers and CI scripts can both write secrets without ever pasting plaintext into a shell history — see [Secrets — operator path](./secrets.md#cli-input-modes).

### Regulated workloads, dual-control / ticket-gated ops

Disable `plaintext`, plus the `dispatch` operations that release execution or destroy registrations:

```bash
kici-admin org-settings dashboard-writes set --sensitivity=plaintext --enabled=false
kici-admin org-settings dashboard-writes set \
  --op held_runs.approve=false \
  --op event_dlq.retry=false \
  --op event_dlq.discard=false \
  --op registration.delete=false \
  --op secrets.delete=false
```

Effect: every dispatch decision and every destructive secret / registration operation requires `kici-admin` invocation, which the operator can wrap in a ticket-gated workflow (the operator's bastion records who ran the command and against which ticket). The dashboard remains usable for observability, secret-name CRUD, and held-run _rejection_ (rejecting a run is safe — it does not release execution).

### Maximum hardening

Disable every operation. The dashboard becomes pure observability plus binding inspection — every mutation goes through `kici-admin`:

```bash
for op in $(kici-admin org-settings dashboard-writes show | awk '/enabled/ { print $1 }'); do
  kici-admin org-settings dashboard-writes set --op "$op=false"
done
```

This is a deliberate trade-off: every workflow that today involves an engineer clicking a dashboard button now requires shell access to the orchestrator operator's bastion. Only adopt this posture if the threat model genuinely requires it; otherwise prefer the more granular postures above.

## What the dashboard does when an operation is disabled

The dashboard reads the current policy from a `GET /api/v1/orgs/:customerId/capabilities` endpoint at page load, then re-fetches every 30 seconds and on every window-focus event. Changes flipped via `kici-admin` from an adjacent terminal converge to open dashboard tabs within ~30 seconds without a manual refresh.

For each disabled operation:

- **The control is rendered with a lock-icon prefix**, grayed out, and inert. Hovering it reveals a tooltip with the operation name, a one-line explanation, and the exact `kici-admin` invocation needed to perform the action. A copy-to-clipboard button puts the command on the clipboard.
- **The page banner** at the top of any page containing at least one disabled operation lists every disabled op on that page plus the CLI equivalent. If every operation on the page is disabled, the banner escalates to "this page is read-only".
- **The Security policy page** (Settings → Security → Dashboard policy) renders the full 24-row matrix, grouped by category, with the live state and the `kici-admin` command for each row.

A control disabled by policy is visually distinct from a control disabled by RBAC: the policy lock icon is universal across the org and points at `kici-admin`; the RBAC disable points at the org's role configuration. Both can apply at once — RBAC wins (the user simply can't see the data).

## Defense in depth

The policy is enforced at three independent layers. Any one of them blocking is sufficient; together they ensure no disabled operation reaches the orchestrator's mutating handler.

### Layer 1 — dashboard render

The web UI reads `useCapabilities()`, swaps disabled controls for their lock-icon counterpart, and never issues a mutating request for a disabled operation. The user doesn't get a half-successful click that produces a confusing error.

### Layer 2 — control-plane HTTP gate

The SaaS control plane caches the orchestrator's capabilities per-org (updated on every orchestrator WebSocket connection and on every `kici-admin` policy change). A `requireOrchCapability(op)` middleware sits on every Platform→Orchestrator route that proxies a mutating dashboard action. Disabled operations get a structured `403`:

```json
{
  "error": "operation_disabled",
  "operation": "secrets.set",
  "category": "Secrets",
  "label": "Set secret value",
  "message": "This orchestrator has disabled \"Set secret value\" via dashboard.",
  "cliEquivalent": "kici-admin secret set"
}
```

A static-grep build-time test asserts that every operation in the registry has at least one route calling `requireOrchCapability` with that operation, and that every `requireOrchCapability` call targets a known operation — adding a new operation without a route gate fails the build.

### Layer 3 — orchestrator handler gate

The orchestrator's `dashboard.*` WebSocket handlers re-check the policy from the orchestrator's own database at request time and refuse the operation if it's disabled. Defense in depth: the control plane's cache could be stale, the control plane itself could misbehave, or a future code path could open a different way of reaching the orchestrator. The orchestrator enforces independently.

A policy-denied request at this layer:

- Returns the same structured envelope on the WebSocket so the client (whether the dashboard SPA or a test harness) sees the same shape it would have seen at the HTTP layer.
- Records an `access_log` row with `outcome='denied'` and `actor_meta = { refused_reason: 'policy_disabled', operation: <op> }`. This row is queryable via `kici-admin access-log` and the dashboard's Activity page.
- Never touches the secret store, the environment store, or any other mutating dependency. The handler short-circuits before any side effect.

A parallel static-grep test asserts that every operation has at least one orchestrator handler with a corresponding `enforcePolicy` call.

### Auditing policy flips

Every `kici-admin org-settings dashboard-writes set` invocation writes one `access_log` row per changed operation, with `action='policy_set'`, the `actor` from the bearer token, and the `prior_state` / `new_state` in `actor_meta`. Query the policy-change history with:

```bash
kici-admin access-log --action=policy_set --limit=50
```

## CLI input modes for the plaintext path

When `secrets.set` and `variables.set` are disabled, the CLI is the only entry path for new values. To make this path practical for both human operators and CI scripts, `kici-admin secret set` and `kici-admin variable set` accept five input modes:

| Flag                  | Source                          | When to use                                                                                                           |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--prompt`            | Interactive no-echo prompt      | Human operator at a terminal (default when stdin is a TTY)                                                            |
| `--from-stdin`        | Read all of stdin until EOF     | Piping from another tool: `pass show foo \| kici-admin secret set ...` (default when stdin is not a TTY)              |
| `--from-file <path>`  | Read file contents              | Bootstrap from a temp file after `sops -d`, etc.                                                                      |
| `--from-env <VAR>`    | Read named environment variable | CI scripts where the secret is injected as an env var                                                                 |
| `--value <plaintext>` | Direct argv plaintext           | Last-resort; prints a stderr warning ("value visible in shell history — prefer --prompt / --from-stdin / --from-env") |

Default-mode resolution: if no input flag is given, the CLI picks `--prompt` when stdin is a TTY and `--from-stdin` when it is not. The CLI never defaults to `--value` — that mode is always explicit.

Two cross-cutting flags work with every input mode:

- `--confirm-fingerprint <hex>` — pre-compute SHA-256 of the value and pass it. The CLI rejects the call if the typed / piped / read value's fingerprint doesn't match. Catches paste corruption.
- `--dry-run` — parse and validate the value, print `[dry-run] would set <key> in scope <scope> sha256=<hex>`, exit without writing.

`kici-admin variable set` accepts the same input modes plus a `--locked` flag to mark the variable as immutable from subsequent dashboard writes.

The full input-mode behavior is documented in [Secrets — operator path](./secrets.md#cli-input-modes).

## Wire shape

The orchestrator's policy view is broadcast to the control plane on every WebSocket auth handshake and on every `kici-admin` policy change as an `orch.capabilities.update` message. The message carries the full 24-operation map plus an opaque `policyVersion` so the control plane can cache-invalidate cleanly:

```json
{
  "type": "orch.capabilities.update",
  "dashboardWrites": {
    "secrets.set": false,
    "variables.set": false,
    "secrets.delete": true,
    "...": "<remaining 21 operations>"
  },
  "policyVersion": "2026-05-17T12:34:56.789Z"
}
```

The dashboard's `GET /api/v1/orgs/:customerId/capabilities` endpoint reads this cache and returns the same shape to the SPA.

## See also

- [Two-layer RBAC](./rbac-two-layers.md) — the dashboard / CLI RBAC asymmetry and the recommended mitigation pattern.
- [Secrets management](./secrets.md) — secret store internals, key rotation, multi-backend setup, and the CLI input modes.
- [Audit log](./audit-log.md) — querying `access_log` rows for policy flips and policy-denied attempts.
