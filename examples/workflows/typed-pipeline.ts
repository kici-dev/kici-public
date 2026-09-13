import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Typed pipeline — step outputs, `needs`, and cross-job wiring (the TS edge).
 *
 * The one example that shows KiCI's core advantage over YAML: outputs are real
 * TypeScript values, not stringly-typed `${{ steps.x.outputs.y }}` interpolation.
 * Inside `build`, the `checksum` step reads `compile.result.artifact` and the
 * compiler type-checks it against the shape `compile` returns — rename the field
 * and every reader breaks at compile time, the guarantee YAML can't give. The
 * `deploy` job then declares `needs: [build]` and reads the build job's outputs;
 * cross-job `.result` is typed too — `build.result.compile.version` threads the
 * `compile` step's return type across the job boundary, so a typo or a renamed
 * field is a compile error just like within a job. Naming your steps and using
 * the options form (`step('name', { run })`) is what carries the type through.
 */

// `compile` PRODUCES typed outputs: the object its `run` returns IS the type of
// `compile.result`. The named-step options form (`step(name, { run })`) is what
// carries the return type through — a bare `step(name, fn)` is a void step whose
// `.result` is `never`. No schema is needed to drive the type (an optional
// `outputs` Zod schema would only add runtime validation, not change the type).
const compile = step('compile', {
  run: async ({ $, log }) => {
    const { stdout } = await $`git rev-parse --short HEAD`;
    const version = `1.0.0+${stdout.trim() || 'dev'}`;
    log.info(`Built version ${version}`);
    return { version, artifact: `app-${version}.tar.gz` };
  },
});

// A later step in the SAME job CONSUMES the earlier step's typed outputs.
// `compile.result.artifact` is `string`; a typo (`.artfact`) or a rename of the
// field above is a compile error here — outputs are checked, not interpolated.
const checksum = step('checksum', {
  run: async ({ log }) => {
    const artifact = compile.result.artifact;
    log.info(`Checksumming ${artifact}`);
    return { sha: `sha256:deadbeef:${artifact}` };
  },
});

const build = job('build', {
  runsOn: 'kici:os:linux',
  steps: [compile, checksum],
});

const deploy = job('deploy', {
  runsOn: 'kici:os:linux',
  // `needs` gates deploy on build finishing AND makes build's outputs readable.
  // Each job runs on its own agent with a fresh clone, so deploy cannot see
  // build's filesystem — job outputs are the sanctioned cross-job channel,
  // carried by the orchestrator, never a shared disk.
  needs: [build],
  steps: [
    step('release', async ({ log }) => {
      // Cross-job reads resolve at runtime from the orchestrator-carried outputs
      // map, shaped `job.result.<stepName>.<field>`, and are typed: `version` is
      // `string`, checked against what the `compile` step returns — no cast, no
      // guessing, a renamed field breaks here at compile time.
      const version = build.result.compile.version;
      log.info(`Deploying ${version}`);
    }),
  ],
});

export default workflow('typed-pipeline', {
  on: push({ branches: ['main'] }),
  jobs: [build, deploy],
});
