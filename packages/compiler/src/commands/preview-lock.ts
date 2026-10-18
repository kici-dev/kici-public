import type { Workflow } from '@kici-dev/sdk';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import type { LockWorkflow } from '../types.js';
import { transformSteps, transformTriggers } from '../lockfile/generator.js';

/** A lock-shaped view for trigger matching and the dry-run printer, steps named as a run names them. */
export function workflowsToPreviewLock(
  workflows: readonly Workflow[],
  gitRoot: string,
): LockWorkflow[] {
  return workflows.map((w) => ({
    name: w.name,
    contentHash: '',
    compileSchemaVersion: 0,
    triggers: transformTriggers(w.on),
    jobs: w.jobs.map((j, i) => {
      if (typeof j === 'function') {
        return { _type: 'dynamic' as const, source: { file: '', index: i } };
      }
      return {
        _type: 'static' as const,
        name: j.name,
        // runsOnAll job has no single-agent selector for the dry-run preview.
        runsOn:
          j.runsOn === undefined
            ? []
            : normalizeRunsOnToMatchers(j.runsOn as never, `job '${j.name}' runsOn`).include,
        needs:
          j.needs?.map((n) => {
            if (typeof n === 'string') return n;
            if ('name' in n) return (n as { name: string }).name;
            if ('group' in n) return `__group:${(n as { group: string }).group}`;
            return (n as { name: string }).name;
          }) ?? [],
        steps: transformSteps(j.steps, gitRoot),
        rules: j.rules?.map((r, ri) => ({
          _type: 'dynamic' as const,
          label: r.label,
          source: { file: '', index: ri },
        })),
        matrix: j.matrix
          ? typeof j.matrix === 'function'
            ? { _type: 'dynamic' as const, source: { file: '', jobName: j.name } }
            : {
                _type: 'static' as const,
                values: j.matrix as string[] | Record<string, string[]>,
              }
          : undefined,
        description: j.description,
      };
    }),
    rules: w.rules?.map((r, i) => ({
      _type: 'dynamic' as const,
      label: r.label,
      source: { file: '', index: i },
    })),
    description: w.description,
  }));
}
