/**
 * Shared rolldown configuration for workflow bundling. The compiler and the
 * agent both use it so bundle output, and so the content hash, is identical.
 */

export interface WorkflowBundleOptions {
  entryPoint: string;
  outfile?: string;
  sourcemap?: boolean | 'inline';
  alias?: Record<string, string>;
  cwd?: string;
}

/**
 * Create a rolldown configuration for workflow bundling. The output is
 * identical whether the compiler or the agent calls it, so content hashes match.
 *
 * @returns rolldown InputOptions with output config
 */
export function createWorkflowBundleConfig(options: WorkflowBundleOptions) {
  return {
    input: options.entryPoint,
    platform: 'node' as const,
    external: ['rolldown', 'typescript', 'zx', '@kici-dev/sdk'],
    treeshake: false,
    cwd: options.cwd,
    resolve: {
      alias: options.alias ?? {},
      mainFields: ['module', 'main'],
      conditionNames: ['import', 'node'],
    },
    output: {
      file: options.outfile,
      format: 'es' as const,
      sourcemap: options.sourcemap ?? false,
      // Force a single chunk even when transitive deps use dynamic `import()`
      // (e.g. library modules that lazy-load `pg` / `@aws-sdk/client-s3`).
      // Otherwise Rolldown demands output.dir, which breaks the compiler's
      // single-file `executeConfig()` flow. `codeSplitting: false` replaces this
      // option in newer Rolldown, but at the pinned version only
      // `inlineDynamicImports` takes effect (the replacement is not typed yet).
      inlineDynamicImports: true,
    },
  };
}
