import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  writeScalerConfig,
  writeAgentWrapper,
  resolveAgentBinary,
  TRUSTED_ROUTING_LABEL,
  IN_PLACE_ROUTING_LABEL,
} from './scaler-config.js';
import { planePaths } from './paths.js';

describe('local-plane scaler-config', () => {
  const saved = process.env.KICI_CONFIG_DIR;
  afterEach(() => {
    process.env.KICI_CONFIG_DIR = saved;
  });

  function freshRoot(): void {
    process.env.KICI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-scaler-'));
  }

  it('resolveAgentBinary resolves the @kici-dev/agent server entry', () => {
    expect(resolveAgentBinary()).toMatch(/agent.*server\.js$/);
  });

  it('writeAgentWrapper writes an executable wrapper that execs node', () => {
    freshRoot();
    const wrapper = writeAgentWrapper();
    expect(wrapper).toBe(planePaths().agentWrapperFile);
    const content = fs.readFileSync(wrapper, 'utf-8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('exec node');
    expect(fs.statSync(wrapper).mode & 0o111).toBeTruthy(); // has an exec bit
  });

  it('writeScalerConfig emits a bare-metal scaler with a default label set', () => {
    freshRoot();
    const file = writeScalerConfig(4319);
    expect(file).toBe(planePaths().scalerConfigFile);
    const parsed = parseYaml(fs.readFileSync(file, 'utf-8')) as {
      version: number;
      scalers: Array<{
        type: string;
        orchestratorUrl: string;
        labelSets: Array<{ labels: string[]; binaryPath: string }>;
      }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.scalers).toHaveLength(1);
    const scaler = parsed.scalers[0];
    expect(scaler.type).toBe('bare-metal');
    expect(scaler.orchestratorUrl).toBe('ws://127.0.0.1:4319/ws');
    expect(scaler.labelSets[0].labels).toEqual(['default']);
    expect(scaler.labelSets[0].binaryPath).toBe(planePaths().agentWrapperFile);
  });

  it('emits a second trusted label set (default+self-hosted) with KICI_TRUSTED_ENV=true', () => {
    freshRoot();
    const file = writeScalerConfig(4319);
    const parsed = parseYaml(fs.readFileSync(file, 'utf-8')) as {
      scalers: Array<{
        labelSets: Array<{ labels: string[]; env?: Record<string, string> }>;
      }>;
    };
    const labelSets = parsed.scalers[0].labelSets;
    expect(labelSets).toHaveLength(3);

    // The trusted (non-in-place) set: exactly [default, self-hosted].
    const trusted = labelSets.find(
      (ls) =>
        ls.labels.includes(TRUSTED_ROUTING_LABEL) && !ls.labels.includes(IN_PLACE_ROUTING_LABEL),
    );
    expect(trusted).toBeDefined();
    expect(trusted!.labels).toEqual(['default', 'self-hosted']);
    expect(trusted!.env).toEqual({ KICI_TRUSTED_ENV: 'true', KICI_SANDBOX: 'false' });

    // The default (sandboxed) set carries no trusted env.
    const sandboxed = labelSets.find((ls) => !ls.labels.includes(TRUSTED_ROUTING_LABEL));
    expect(sandboxed!.env).toBeUndefined();

    // No label set uses a reserved kici: label.
    for (const ls of labelSets) {
      expect(ls.labels.some((l) => l.startsWith('kici:'))).toBe(false);
    }
  });

  it('emits a trusted in-place label set (default+self-hosted+in-place) with KICI_IN_PLACE=true', () => {
    freshRoot();
    const file = writeScalerConfig(4319);
    const parsed = parseYaml(fs.readFileSync(file, 'utf-8')) as {
      scalers: Array<{
        labelSets: Array<{ labels: string[]; env?: Record<string, string> }>;
      }>;
    };
    const labelSets = parsed.scalers[0].labelSets;
    const inPlace = labelSets.find((ls) => ls.labels.includes(IN_PLACE_ROUTING_LABEL));
    expect(inPlace).toBeDefined();
    expect(inPlace!.labels).toEqual(['default', 'self-hosted', 'in-place']);
    expect(inPlace!.env).toEqual({
      KICI_TRUSTED_ENV: 'true',
      KICI_SANDBOX: 'false',
      KICI_IN_PLACE: 'true',
    });
  });
});
