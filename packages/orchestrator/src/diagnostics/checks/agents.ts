/** Agent connectivity check. Zero agents only warns: agents may be scaling up. */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';

export async function checkAgentConnectivity(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  if (!deps.agentRegistry) {
    return {
      name: 'Agent connectivity',
      status: 'warn',
      message: 'Agent registry not available',
      durationMs: Date.now() - start,
    };
  }

  const count = deps.agentRegistry.getActiveCount();
  const durationMs = Date.now() - start;

  if (count > 0) {
    return {
      name: 'Agent connectivity',
      status: 'pass',
      message: `${count} agent(s) connected`,
      details: { agentCount: count },
      durationMs,
    };
  }

  return {
    name: 'Agent connectivity',
    status: 'warn',
    message: 'No agents connected',
    details: { agentCount: 0 },
    durationMs,
  };
}
