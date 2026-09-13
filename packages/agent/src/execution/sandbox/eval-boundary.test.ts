import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The eval child's boundary, asserted where it is decided: in the import graph
 * and in the message union.
 *
 * A behavioural test cannot see this. The defect was that customer workflow
 * modules were `import()`ed in the AGENT process, and the fix is that the agent
 * no longer has the loader in its module graph at all — so the assertion is
 * static, with a positive control on every negative claim.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const jobRunnerSrc = read('../job-runner.ts');
const evalDispatchSrc = read('./eval-dispatch.ts');
const evalRunnerSrc = read('./eval-runner.ts');
const evalForkRunnerSrc = read('./eval-fork-runner.ts');
const ipcSrc = read('./ipc-protocol.ts');

describe('the agent process never loads a customer workflow module', () => {
  it('positive control: the eval child does load it', () => {
    expect(evalDispatchSrc).toContain("from '../workflow-loader.js'");
    expect(evalDispatchSrc).toContain('loadWorkflowSource(');
  });

  it('the job runner imports neither the workflow loader nor the generator context', () => {
    expect(jobRunnerSrc).not.toContain("from './workflow-loader.js'");
    expect(jobRunnerSrc).not.toContain("from './generator-context.js'");
    expect(jobRunnerSrc).not.toContain("from './dynamic-job-serializer.js'\n");
  });

  it('the job runner calls neither loadWorkflowSource nor extractDynamicJobFn', () => {
    expect(jobRunnerSrc).not.toContain('loadWorkflowSource(');
    expect(jobRunnerSrc).not.toContain('extractDynamicJobFn(');
    expect(jobRunnerSrc).not.toContain('buildGeneratorContext(');
  });

  it('every evaluation handler routes through the eval child', () => {
    // One `runEvaluation` call per migrated handler: init, dynamic-job,
    // build-verify, global-eval.
    for (const kind of [
      "kind: 'init'",
      "kind: 'dynamic-job'",
      "kind: 'build-verify'",
      "kind: 'global-eval'",
    ]) {
      expect(jobRunnerSrc).toContain(kind);
    }
  });
});

describe('the eval request carries no secrets', () => {
  it('positive control: the request type names the fields it does carry', () => {
    expect(ipcSrc).toContain('export interface EvalRequest {');
    expect(ipcSrc).toContain('  kind: EvalRequestKind;');
  });

  it('neither the request type nor the agent-side builder mentions secrets', () => {
    const evalRequestBlock = ipcSrc.slice(
      ipcSrc.indexOf('export interface EvalRequest {'),
      ipcSrc.indexOf('/** Instruct the eval child to run one evaluation. */'),
    );
    expect(evalRequestBlock).not.toContain('secrets');
    expect(evalRequestBlock).not.toContain('namespacedSecrets');

    // The agent-side builder enumerates the dispatch fields it forwards. Its
    // comments are stripped first: one of them says the request carries no
    // secrets, and matching that sentence would make this assertion vacuous.
    const builder = jobRunnerSrc
      .slice(
        jobRunnerSrc.indexOf('  private runEvaluation<T>('),
        jobRunnerSrc.indexOf('  private async handleInitJob('),
      )
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(builder).toContain('sourceAuth: args.dispatch.sourceAuth');
    expect(builder).not.toContain('secrets');
    expect(builder).not.toContain('agentToken');
  });
});

describe('the eval IPC union carries no privileged relay but the API one', () => {
  it('positive control: the step runner union does carry them', () => {
    expect(ipcSrc).toContain('  | CacheRequestIpc');
    expect(ipcSrc).toContain('  | ProvenanceRequestIpc');
  });

  it('the eval union names exactly its five inbound messages', () => {
    const union = ipcSrc.slice(ipcSrc.indexOf('export type EvalToAgentMessage ='));
    expect(union).toContain('EvalReadyMessage');
    expect(union).toContain('EvalLogLineMessage');
    expect(union).toContain('EvalApiRequestMessage');
    expect(union).toContain('EvalResultMessage');
    expect(union).toContain('EvalErrorMessage');
    for (const relay of [
      'CacheRequestIpc',
      'ProvenanceRequestIpc',
      'ArtifactRequestIpc',
      'GitGrantRequestIpc',
      'StepApprovalRequestIpc',
    ]) {
      expect(union).not.toContain(relay);
    }
  });

  it('the driver handles only the eval union and warns on anything else', () => {
    expect(evalForkRunnerSrc).toContain("case 'eval.result':");
    expect(evalForkRunnerSrc).toContain("case 'eval.error':");
    expect(evalForkRunnerSrc).toContain('Ignoring unexpected message from eval child');
    for (const relay of ['cache.request', 'provenance.request', 'artifact.request', 'git.grant']) {
      expect(evalForkRunnerSrc).not.toContain(relay);
    }
  });

  it('the child is forked with a sanitized env built from {}, never process.env', () => {
    expect(evalForkRunnerSrc).toContain(
      'buildSanitizedEnv({}, { trustedEnv: options.trustedEnv })',
    );
    expect(evalForkRunnerSrc).not.toContain('buildSanitizedEnv(process.env');
  });

  it('the child exits after reporting, so a customer timer cannot keep it alive', () => {
    expect(evalRunnerSrc).toContain('process.exit(0)');
    expect(evalRunnerSrc).toContain('process.exit(1)');
  });
});
