import { describe, it, expect } from 'vitest';
import { evaluateInlineString, evaluateInlineRecord, evaluateInlineFields } from './inline-eval.js';
import type { LockJob } from '@kici-dev/engine';

describe('evaluateInlineString', () => {
  it('evaluates arrow function with event.ref', () => {
    const result = evaluateInlineString('(event) => event.ref.split("/").pop()', {
      ref: 'refs/heads/main',
    });
    expect(result).toBe('main');
  });

  it('evaluates template literal expression', () => {
    const result = evaluateInlineString('(event) => `deploy-${event.environment}`', {
      environment: 'staging',
    });
    expect(result).toBe('deploy-staging');
  });

  it('evaluates destructured parameter', () => {
    const result = evaluateInlineString('({ ref }) => ref.split("/").pop()', {
      ref: 'refs/heads/feature',
    });
    expect(result).toBe('feature');
  });

  it('throws TypeError when expression returns non-string', () => {
    expect(() => evaluateInlineString('(event) => 42', {})).toThrow(TypeError);
    expect(() => evaluateInlineString('(event) => 42', {})).toThrow('must return a string');
  });

  it('times out on infinite loop within 200ms', () => {
    const start = Date.now();
    expect(() => evaluateInlineString('(event) => { while(true) {} }', {})).toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('sandbox blocks process access', () => {
    expect(() => evaluateInlineString('(event) => process.env.HOME', {})).toThrow();
  });

  it('sandbox blocks require access', () => {
    expect(() =>
      evaluateInlineString('(event) => require("fs").readFileSync("/etc/passwd", "utf8")', {}),
    ).toThrow();
  });

  it('sandbox isolates globalThis from host', () => {
    // globalThis in a vm sandbox refers to the sandbox object, not the host.
    // Verify host globals (like setTimeout, Buffer) are not accessible.
    expect(() => evaluateInlineString('(event) => setTimeout.toString()', {})).toThrow();
  });
});

describe('evaluateInlineRecord', () => {
  it('evaluates arrow function returning object', () => {
    const result = evaluateInlineRecord('(event) => ({ NODE_ENV: event.env })', {
      env: 'production',
    });
    expect(result).toEqual({ NODE_ENV: 'production' });
  });

  it('evaluates multi-key object', () => {
    const result = evaluateInlineRecord('(event) => ({ A: "1", B: event.val })', { val: '2' });
    expect(result).toEqual({ A: '1', B: '2' });
  });

  it('throws TypeError when expression returns non-object', () => {
    expect(() => evaluateInlineRecord('(event) => "string"', {})).toThrow(TypeError);
    expect(() => evaluateInlineRecord('(event) => "string"', {})).toThrow('must return an object');
  });

  it('throws TypeError when expression returns null', () => {
    expect(() => evaluateInlineRecord('(event) => null', {})).toThrow(TypeError);
    expect(() => evaluateInlineRecord('(event) => null', {})).toThrow('must return an object');
  });

  it('throws TypeError when expression returns array', () => {
    expect(() => evaluateInlineRecord('(event) => [1, 2, 3]', {})).toThrow(TypeError);
    expect(() => evaluateInlineRecord('(event) => [1, 2, 3]', {})).toThrow('must return an object');
  });
});

describe('evaluateInlineFields', () => {
  const envelope = {
    type: 'pull_request',
    action: 'opened',
    targetBranch: 'main',
    sourceBranch: 'feat/x',
    payload: { pull_request: { number: 7 }, ref: undefined },
  };

  it('evaluates inline environment/env/concurrencyGroup against the normalized envelope', () => {
    const lockJob = {
      _type: 'static',
      name: 'deploy',
      runsOn: 'default',
      needs: [],
      steps: [],
      environment: {
        _type: 'inline',
        expression: "(event) => event.type === 'pull_request' ? 'preview' : 'production'",
      },
      env: {
        _type: 'inline',
        expression: '(event) => ({ PR: String(event.payload.pull_request.number) })',
      },
      concurrencyGroup: {
        _type: 'inline',
        expression: '(event) => `cg-${event.targetBranch}`',
      },
    } as unknown as LockJob;

    const result = evaluateInlineFields(lockJob, envelope);
    expect(result.inlineEnvironmentName).toBe('preview');
    expect(result.inlineEnv).toEqual({ PR: '7' });
    expect(result.inlineConcurrencyGroup).toBe('cg-main');
  });

  it('throws a job-attributed error when an inline expression throws', () => {
    const lockJob = {
      _type: 'static',
      name: 'bad',
      runsOn: 'default',
      needs: [],
      steps: [],
      environment: { _type: 'inline', expression: '(event) => event.nope.deref' },
    } as unknown as LockJob;
    expect(() => evaluateInlineFields(lockJob, envelope)).toThrow(/job 'bad'/);
  });
});
