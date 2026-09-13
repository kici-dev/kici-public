/**
 * Secret merging utilities for the workflow runner.
 *
 * Separated from workflow-runner.ts to allow unit testing without
 * triggering the runner's top-level side effects (process handlers, main()).
 */

/**
 * Merge orchestrator-level secrets with auto-flattened context keys.
 *
 * Precedence (last wins):
 * 1. Orchestrator-level secrets (lowest)
 * 2. Context-flattened keys in declaration order (each context's keys overlay previous)
 *
 * This means: context-flattened keys override orchestrator-level secrets,
 * and for collisions between contexts, last declared context wins.
 */
export function buildMergedFlatSecrets(
  orchestratorSecrets: Record<string, string>,
  namespacedSecrets: Record<string, Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...orchestratorSecrets };
  for (const contextSecrets of Object.values(namespacedSecrets)) {
    Object.assign(merged, contextSecrets);
  }
  return merged;
}
