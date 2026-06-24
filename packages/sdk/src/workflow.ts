import type { Workflow, WorkflowOptions, Trigger } from './types.js';
import type { TriggerConfig } from './triggers/types.js';

/**
 * Normalize triggers to array.
 * Handles single trigger config or array of trigger configs.
 */
function normalizeTriggers(on?: Trigger | Trigger[]): TriggerConfig[] | undefined {
  if (!on) return undefined;
  return Array.isArray(on) ? on : [on];
}

/**
 * Create a workflow containing jobs.
 *
 * @example
 * // Simple workflow
 * export default workflow('ci', {
 *   jobs: [build, test, deploy],
 * });
 *
 * @example
 * // Workflow with triggers and rules
 * export default workflow('ci', {
 *   on: [pr({ target: 'main' }), push({ branches: 'main' })],
 *   jobs: [build, test, deploy],
 *   rules: [rule('has src changes')],
 *   description: 'Main CI pipeline',
 * });
 */
/**
 * Validates a `<environment>:<secret-name>` qualified secret reference.
 * Both halves must be non-empty and free of additional colons.
 */
function isQualifiedSecretRef(value: string): boolean {
  const idx = value.indexOf(':');
  if (idx <= 0 || idx >= value.length - 1) return false;
  const env = value.slice(0, idx);
  const name = value.slice(idx + 1);
  return env.length > 0 && name.length > 0 && !name.includes(':');
}

export function workflow(name: string, options: WorkflowOptions): Workflow {
  if (options.registries) {
    const seenScopes = new Set<string>();
    let defaultCount = 0;
    for (const [i, reg] of options.registries.entries()) {
      try {
        new URL(reg.url);
      } catch {
        throw new Error(`workflow('${name}'): registries[${i}].url is not a valid URL: ${reg.url}`);
      }
      if (!isQualifiedSecretRef(reg.tokenSecret)) {
        throw new Error(
          `workflow('${name}'): registries[${i}].tokenSecret must use qualified <environment>:<secret-name> syntax (got: ${reg.tokenSecret})`,
        );
      }
      if (reg.scope === undefined) {
        defaultCount += 1;
      } else {
        if (!/^@[a-z0-9][a-z0-9-]*$/i.test(reg.scope)) {
          throw new Error(
            `workflow('${name}'): registries[${i}].scope must match @<package-scope> (got: ${reg.scope})`,
          );
        }
        if (seenScopes.has(reg.scope)) {
          throw new Error(
            `workflow('${name}'): registries declares scope ${reg.scope} more than once`,
          );
        }
        seenScopes.add(reg.scope);
      }
    }
    if (defaultCount > 1) {
      throw new Error(
        `workflow('${name}'): at most one registries entry may omit \`scope\` (default registry); got ${defaultCount}`,
      );
    }
  }
  if (options.installEnv) {
    for (const [i, ref] of options.installEnv.entries()) {
      if (!isQualifiedSecretRef(ref)) {
        throw new Error(
          `workflow('${name}'): installEnv[${i}] must use qualified <environment>:<secret-name> syntax (got: ${ref})`,
        );
      }
    }
  }
  return {
    _tag: 'Workflow' as const,
    name,
    jobs: options.jobs,
    on: normalizeTriggers(options.on),
    rules: options.rules,
    description: options.description,
    hashFiles: options.hashFiles,
    registries: options.registries,
    installEnv: options.installEnv,
    timeout: options.timeout,
    onCancel: options.onCancel,
    cleanup: options.cleanup,
    onSuccess: options.onSuccess,
    onFailure: options.onFailure,
    concurrency: options.concurrency,
    approval: options.approval,
  };
}
