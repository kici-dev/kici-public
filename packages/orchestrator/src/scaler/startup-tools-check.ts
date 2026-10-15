/**
 * The scaler tools check the orchestrator runs at startup, before it builds
 * any scaler backend.
 */

import { validateRequiredTools } from '@kici-dev/shared';
import { requiredToolsFor } from './backend-factory.js';
import {
  bareMetalAgentBinaryHint,
  bareMetalVersionManagerErrors,
} from './agent-binary-location.js';
import type { ScalerEntry } from './types.js';

/**
 * Why the configured scalers cannot run on this host, as one message for the
 * startup log, or null when every required tool is present.
 *
 * A bare-metal `binaryPath` that is a version-manager shim passes the
 * executable check, so it is refused on its own. When a bare-metal
 * `binaryPath` fails, the message names the `kici-agent` installed with this
 * orchestrator's runtime: a path into another Node.js runtime or through a
 * shim is the usual cause.
 */
export function scalerStartupToolsFailure(
  entries: ScalerEntry[],
  runtime: { entryPath: string | undefined; execPath: string; windows: boolean },
): string | null {
  const errors = [
    ...validateRequiredTools(requiredToolsFor(entries)),
    ...bareMetalVersionManagerErrors(entries),
  ];
  if (errors.length === 0) return null;
  const hint = bareMetalAgentBinaryHint(entries, runtime);
  return (
    'Required tools validation failed:\n' +
    errors.map((e) => `  - ${e}`).join('\n') +
    (hint ? `\n${hint}` : '')
  );
}
