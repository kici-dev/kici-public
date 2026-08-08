/**
 * Infrastructure alert vocabulary — the single definition of what a diagnostics
 * infrastructure alert's `type` and `severity` can be.
 *
 * Lives beside the other shared vocabularies (`billing/plan-type.ts`,
 * `context/held-run-status.ts`) rather than in the protocol module, so the
 * Platform producer, the dashboard, and the `kici` CLI all name one enum
 * instead of each carrying a copy. Pure Zod with no Node built-ins, so it is
 * safe on the browser-facing engine barrel.
 *
 * This is the *known* vocabulary — the set the Platform mints alerts from and
 * the set the read-side consumers colour their badges by. It is deliberately
 * NOT the wire type of the response fields. The hosted Platform always runs the
 * newest build, while a customer's `kici` CLI is pinned to whatever version
 * they installed and hard-parses this response
 * (`packages/compiler/src/remote/dashboard-client.ts`). A strict enum on the
 * wire would not degrade one alert row — it would fail the whole
 * `/diagnostics/infrastructure` parse and take `kici diagnostics` down with it
 * the day a fifth alert type ships. So the response carries `z.string()` and
 * the producer carries the enum: strict on write, permissive on read.
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
 * vocabulary.
 *
 * The producer annotates its accumulator with this type, which is what turns a
 * misspelled or unranked alert type into a `pnpm typecheck` failure at the mint
 * site rather than a string that validates on the wire and renders as an
 * unrecognised row.
 */
export interface MintedInfraAlert {
  type: InfraAlertType;
  message: string;
  severity: InfraAlertSeverity;
}

/**
 * Resolve an arbitrary severity string read off the wire to a known severity.
 *
 * An unrecognised value resolves to `critical`. A client older than the
 * Platform cannot know whether a severity it has never seen is quieter or
 * louder than `critical`, and on an operator surface the safe reading of "I
 * don't know" is the conspicuous one. A plain `severity === 'critical'`
 * comparison instead reads every unrecognised value as a yellow warning, so a
 * `critcal` typo silently downgrades a critical alert.
 *
 * `safeParse` is a set membership test, so an attacker-supplied
 * `constructor` / `toString` cannot walk the prototype chain the way a bare
 * object index would.
 */
export function normalizeInfraAlertSeverity(severity: string): InfraAlertSeverity {
  const parsed = InfraAlertSeverity.safeParse(severity);
  return parsed.success ? parsed.data : InfraAlertSeverity.enum.critical;
}
