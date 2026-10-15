/**
 * Kept out of workflow-runner.ts so tests avoid the runner's top-level side
 * effects (process handlers, main()).
 */

/**
 * Merge orchestrator-level secrets with auto-flattened context keys. Context
 * keys override orchestrator-level secrets; between contexts the last
 * declared wins.
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
