/**
 * Shared rolldown configuration for workflow bundling.
 *
 * Both the compiler and agent import this factory to guarantee identical
 * bundle output, which is critical for content hash verification.
 */

export interface WorkflowBundleOptions {
  entryPoint: string;
  outfile?: string;
  sourcemap?: boolean | 'inline';
  alias?: Record<string, string>;
  cwd?: string;
}

/**
 * Create a rolldown configuration for workflow bundling.
 *
 * The returned config produces identical output regardless of whether
 * it's called from the compiler or agent, ensuring content hash consistency.
 *
 * @param options - Bundle configuration
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
      // Force a single output chunk even when transitive deps use dynamic
      // `import()` (e.g. our staging deploy workflow imports library modules
      // that lazy-load `pg` / `@aws-sdk/client-s3`). Without this, Rolldown
      // hits "output.dir required for multiple chunks" — and switching to
      // output.dir would break the single-file `executeConfig()` flow in the
      // compiler's hot path. `inlineDynamicImports: true` is deprecated in
      // newer Rolldown in favor of `codeSplitting: false`, but at the
      // currently-pinned version the deprecated option is still the one
      // that actually takes effect (the suggested replacement isn't in the
      // type surface yet).
      inlineDynamicImports: true,
    },
  };
}
