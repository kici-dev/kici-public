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

  interface ParsedLabelSet {
    labels: string[];
    binaryPath?: string;
    env?: Record<string, string>;
  }
  interface ParsedScaler {
    name: string;
    type: string;
    orchestratorUrl: string;
    mandatoryLabels?: string[];
    labelSets: ParsedLabelSet[];
  }

  function parseScalers(port = 4319): ParsedScaler[] {
    const file = writeScalerConfig(port);
    expect(file).toBe(planePaths().scalerConfigFile);
    const parsed = parseYaml(fs.readFileSync(file, 'utf-8')) as {
      version: number;
      scalers: ParsedScaler[];
    };
    expect(parsed.version).toBe(1);
    return parsed.scalers;
  }

  function allLabelSets(scalers: ParsedScaler[]): ParsedLabelSet[] {
    return scalers.flatMap((s) => s.labelSets);
  }

  it('emits a sandboxed bare-metal scaler with a single untainted default label set', () => {
    freshRoot();
    const scalers = parseScalers();
    const sandboxed = scalers.find((s) => s.name === 'kici-local-bare-metal');
    expect(sandboxed).toBeDefined();
    expect(sandboxed!.type).toBe('bare-metal');
    expect(sandboxed!.orchestratorUrl).toBe('ws://127.0.0.1:4319/ws');
    // Sandboxed pool: exactly the default label set, no trusted env, no taint.
    expect(sandboxed!.labelSets).toHaveLength(1);
    expect(sandboxed!.labelSets[0].labels).toEqual(['default']);
    expect(sandboxed!.labelSets[0].binaryPath).toBe(planePaths().agentWrapperFile);
    expect(sandboxed!.labelSets[0].env).toBeUndefined();
    expect(sandboxed!.mandatoryLabels ?? []).toEqual([]);
  });

  it('emits a self-hosted-tainted trusted scaler with the two trusted label sets', () => {
    freshRoot();
    const scalers = parseScalers();
    const trusted = scalers.find((s) => s.name === 'kici-local-bare-metal-trusted');
    expect(trusted).toBeDefined();
    expect(trusted!.type).toBe('bare-metal');
    // The taint: only jobs requesting `self-hosted` may route to this pool.
    expect(trusted!.mandatoryLabels).toEqual([TRUSTED_ROUTING_LABEL]);
    expect(trusted!.labelSets).toHaveLength(2);

    const trustedSet = trusted!.labelSets.find((ls) => !ls.labels.includes(IN_PLACE_ROUTING_LABEL));
    expect(trustedSet!.labels).toEqual(['default', 'self-hosted']);
    expect(trustedSet!.env).toEqual({ KICI_TRUSTED_ENV: 'true', KICI_SANDBOX: 'false' });

    const inPlace = trusted!.labelSets.find((ls) => ls.labels.includes(IN_PLACE_ROUTING_LABEL));
    expect(inPlace!.labels).toEqual(['default', 'self-hosted', 'in-place']);
    expect(inPlace!.env).toEqual({
      KICI_TRUSTED_ENV: 'true',
      KICI_SANDBOX: 'false',
      KICI_IN_PLACE: 'true',
    });

    // Every trusted label set carries the mandatory taint label (validator
    // invariant: a mandatory label must appear in every label set of its scaler).
    for (const ls of trusted!.labelSets) {
      expect(ls.labels).toContain(TRUSTED_ROUTING_LABEL);
    }
  });

  it('no label set uses a reserved kici: label', () => {
    freshRoot();
    for (const ls of allLabelSets(parseScalers())) {
      expect(ls.labels.some((l) => l.startsWith('kici:'))).toBe(false);
    }
  });

  // Security invariant (regression guard for the non-trusted ambient-env leak):
  // a bare `default` run must be UNABLE to reach any trusted label set. Every
  // pool whose label-set env sets KICI_TRUSTED_ENV=true MUST be tainted with a
  // mandatoryLabel that `['default']` does not satisfy — so the orchestrator's
  // agent-registry gate (and the scaler spawn matcher) both keep a sandboxed
  // job off every trusted agent, even a lingering idle one.
  it('every trusted (KICI_TRUSTED_ENV=true) pool is tainted against a bare default job', () => {
    freshRoot();
    const scalers = parseScalers();
    const defaultRunLabels = ['default'];

    let trustedPools = 0;
    for (const scaler of scalers) {
      const isTrustedPool = scaler.labelSets.some((ls) => ls.env?.KICI_TRUSTED_ENV === 'true');
      if (!isTrustedPool) continue;
      trustedPools++;
      const mandatory = scaler.mandatoryLabels ?? [];
      expect(mandatory.length).toBeGreaterThan(0);
      // The taint gate: at least one mandatory label is absent from a default
      // run's runsOn, so the gate rejects it.
      const gatePasses = mandatory.every((m) =>
        defaultRunLabels.map((l) => l.toLowerCase()).includes(m.toLowerCase()),
      );
      expect(gatePasses).toBe(false);
    }
    // Guard the guard: there IS a trusted pool to check.
    expect(trustedPools).toBeGreaterThan(0);
  });
});
