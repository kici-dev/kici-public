import { CheckMode } from '@kici-dev/engine';

/** The two run-mode flags shared by `kici run local` and `kici run remote`. */
export interface CheckModeFlags {
  /** --check: report drift, change nothing. */
  check?: boolean;
  /** --fail-on-drift: in check mode, exit non-zero if any step reports drift. */
  failOnDrift?: boolean;
}

/**
 * Resolve the run {@link CheckMode} from the `--check` / `--fail-on-drift` flags.
 *
 * - no flags -> `apply` (the unchanged default: converge).
 * - `--check` -> `check` (report-only, changes nothing).
 * - `--check --fail-on-drift` -> `check-fail-on-drift` (fails the run on drift).
 *
 * `--fail-on-drift` without `--check` is an error — it only modifies check mode.
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
