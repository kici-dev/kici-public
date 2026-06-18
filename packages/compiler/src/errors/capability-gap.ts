/**
 * Actionable error format for CLI-side capability gaps.
 *
 * When the CLI calls an orchestrator feature the orchestrator doesn't support
 * (e.g. `kici status --logs` against an older orchestrator that lacks the
 * `/runs/:runId/logs` endpoint), it should tell the operator:
 *   - which feature is missing,
 *   - the CLI's own version,
 *   - the orchestrator's advertised version (fetched from `/capabilities`,
 *     `undefined` if that fetch failed),
 *   - and how to resolve it.
 *
 * Every capability-gap error in the CLI flows through `formatCapabilityGapError`
 * so the format stays consistent. Call sites either throw `CapabilityGapError`
 * (caught at the command boundary and printed) or call the formatter directly.
 */

import pc from 'picocolors';

export interface CapabilityGapInfo {
  /** Short feature name, e.g. `log-streaming`. Shown verbatim in the error. */
  feature: string;
  /** CLI package version (from `KICI_VERSION` build constant). */
  cliVersion: string;
  /**
   * Orchestrator's advertised version from `GET /api/v1/capabilities`.
   * `undefined` when the capabilities probe itself failed (old orchestrator,
   * network error, etc.) — the formatter prints `unknown` and notes the cause.
   */
  orchestratorVersion?: string;
  /**
   * Optional override for the trailing guidance paragraph. Default guidance
   * tells the operator to upgrade the orchestrator and how to confirm its
   * current version.
   */
  guidance?: string;
}

const DEFAULT_GUIDANCE =
  'Upgrade the orchestrator to the latest KiCI release to enable this feature.\n' +
  'Run `kici-admin version` on the orchestrator host to confirm the current version.';

/**
 * Error thrown by CLI code when a capability gap is detected. Command-level
 * catchers format the attached `info` via `formatCapabilityGapError`.
 */
export class CapabilityGapError extends Error {
  readonly info: CapabilityGapInfo;

  constructor(info: CapabilityGapInfo) {
    super(`Feature not supported: ${info.feature}`);
    this.name = 'CapabilityGapError';
    this.info = info;
  }
}

/**
 * Produce the user-facing multi-line error string for a capability gap.
 *
 * The shape is stable (tests snapshot it). Colours come from picocolors and
 * degrade gracefully in non-TTY output.
 */
export function formatCapabilityGapError(info: CapabilityGapInfo): string {
  const orchLine = info.orchestratorVersion
    ? info.orchestratorVersion
    : 'unknown (capabilities endpoint unreachable)';

  const guidance = info.guidance ?? DEFAULT_GUIDANCE;

  return [
    pc.red(pc.bold(`Feature not supported by the orchestrator: ${info.feature}`)),
    '',
    `  CLI version:          ${info.cliVersion}`,
    `  Orchestrator version: ${orchLine}`,
    '',
    ...guidance.split('\n').map((line) => `  ${pc.dim(line)}`),
  ].join('\n');
}
