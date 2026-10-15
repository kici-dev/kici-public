/**
 * Infrastructure alert vocabulary — the single definition of a diagnostics
 * infrastructure alert's `type` and `severity`. It lives with the shared
 * vocabularies, not in the protocol module, so the Platform producer, the
 * dashboard and the `kici` CLI name one enum instead of each carrying a copy.
 * No Node built-ins, so it is safe on the browser-facing engine barrel.
 *
 * This is the *known* vocabulary — the set the Platform mints alerts from and
 * the read-side consumers colour their badges by. It is deliberately NOT the
 * wire type of the response fields. The hosted Platform always runs the newest
 * build, while a customer's `kici` CLI is pinned and hard-parses this response
 * (`packages/compiler/src/remote/dashboard-client.ts`). A strict enum on the
 * wire would fail the whole `/diagnostics/infrastructure` parse, and with it
 * `kici diagnostics`, the day a fifth alert type ships. So the response carries
 * `z.string()` and the producer carries the enum: strict on write, permissive
 * on read.
 */
import { z } from 'zod';

/**
 * Known infrastructure alert types, matching what the Platform mints from the
 * state it computes about connected orchestrators.
 */
export const InfraAlertType = z.enum(['zero-agents', 'capacity', 'label-gaps', 'no-raft-leader']);
export type InfraAlertType = z.infer<typeof InfraAlertType>;

/** Every known alert type, in declaration order. */
export const INFRA_ALERT_TYPES: readonly InfraAlertType[] = InfraAlertType.options;

/** Known alert severities, in ascending urgency. */
export const InfraAlertSeverity = z.enum(['warning', 'critical']);
export type InfraAlertSeverity = z.infer<typeof InfraAlertSeverity>;

/**
 * An alert as the Platform mints it, with both fields narrowed to the known
 * vocabulary. The producer's accumulator uses this type, so a misspelled or
 * unranked alert type fails `pnpm typecheck` at the mint site instead of
 * rendering as an unrecognised row.
 */
export interface MintedInfraAlert {
  type: InfraAlertType;
  message: string;
  severity: InfraAlertSeverity;
}

/**
 * Resolve an arbitrary severity string read off the wire to a known severity.
 *
 * An unrecognised value resolves to `critical`: a client older than the
 * Platform cannot rank a severity it has never seen, and on an operator surface
 * the safe reading of "unknown" is the conspicuous one. A plain
 * `severity === 'critical'` comparison would read a `critcal` typo as a yellow
 * warning and silently downgrade a critical alert.
 *
 * `safeParse` is a set membership test, so an attacker-supplied
 * `constructor` / `toString` cannot walk the prototype chain the way a bare
 * object index would.
 */
export function normalizeInfraAlertSeverity(severity: string): InfraAlertSeverity {
  const parsed = InfraAlertSeverity.safeParse(severity);
  return parsed.success ? parsed.data : InfraAlertSeverity.enum.critical;
}
