import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '@kici-dev/sdk';
import { resolveEmitEventName } from './workflow-runner.js';

describe('resolveEmitEventName', () => {
  it('resolves a defineEvent() definition to its name', () => {
    const deployComplete = defineEvent('deploy-complete', z.object({ env: z.string() }));
    expect(resolveEmitEventName(deployComplete)).toBe('deploy-complete');
  });

  it('passes an ad-hoc event-name string through unchanged', () => {
    expect(resolveEmitEventName('build-done')).toBe('build-done');
  });
});
