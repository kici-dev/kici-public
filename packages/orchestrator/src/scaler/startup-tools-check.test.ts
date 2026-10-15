/**
 * The startup scaler tools check, against real files: a version-manager shim
 * passes the executable check that `validateRequiredTools` runs, so only the
 * shim detection can refuse it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScalerBackendType } from '@kici-dev/engine';
import { scalerStartupToolsFailure } from './startup-tools-check.js';
import type { ScalerEntry } from './types.js';

describe('scalerStartupToolsFailure', () => {
  let root: string;
  let runtime: { entryPath: undefined; execPath: string; windows: false };
  let agent: string;
  let shim: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-startup-tools-'));
    const touch = (rel: string): string => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
      return file;
    };
    // The runtime the orchestrator runs: node with kici-agent beside it.
    runtime = { entryPath: undefined, execPath: touch('rt/bin/node'), windows: false };
    agent = touch('rt/bin/kici-agent');
    // A mise shim: a link in mise's shims folder to the mise executable.
    shim = path.join(root, 'mise', 'shims', 'kici-agent');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.symlinkSync(touch('vm/mise'), shim);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = (binaryPath: string): ScalerEntry[] => [
    {
      name: 'bm',
      type: ScalerBackendType.enum['bare-metal'],
      labelSets: [{ labels: ['linux'], binaryPath }],
    } as unknown as ScalerEntry,
  ];

  it('refuses a binaryPath that is a mise shim, and names the installed agent', () => {
    const detail = scalerStartupToolsFailure(config(shim), runtime);
    // fails-when: startup runs only the executable check, which the mise
    // executable passes, so the orchestrator starts and no agent ever does.
    expect(detail).toMatch(/^Required tools validation failed:\n/);
    expect(detail).toContain(`binaryPath ${shim} is a version-manager shim (mise)`);
    expect(detail).toContain('`mise which kici-agent`');
    expect(detail).toContain(`runtime is ${agent}.`);
  });

  it('passes an executable agent', () => {
    // breaks-if-wrong: a real agent must still start the orchestrator.
    expect(scalerStartupToolsFailure(config(agent), runtime)).toBeNull();
  });
});
