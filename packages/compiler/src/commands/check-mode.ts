import { CheckMode } from '@kici-dev/engine';

/** `kici run remote` check-mode flags. */
export interface CheckModeFlags {
  /** --check: report drift, change nothing. */
  check?: boolean;
  /** --fail-on-drift: in check mode, exit non-zero if any step reports drift. */
  failOnDrift?: boolean;
}

/**
 * No flags → `apply` (converge); `--check` → `check`; both →
 * `check-fail-on-drift`. `--fail-on-drift` alone is an error: it only modifies
 * check mode.
 */
export function resolveCheckMode(flags: CheckModeFlags): CheckMode {
  if (flags.failOnDrift && !flags.check) {
    throw new Error('--fail-on-drift requires --check');
  }
  if (flags.check) {
    return flags.failOnDrift ? CheckMode.enum['check-fail-on-drift'] : CheckMode.enum.check;
  }
  return CheckMode.enum.apply;
}
