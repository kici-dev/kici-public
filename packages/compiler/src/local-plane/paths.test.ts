import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { planeRoot, planePaths, planePorts } from './paths.js';

describe('local-plane paths', () => {
  const saved = { cfg: process.env.KICI_CONFIG_DIR, op: process.env.KICI_LOCAL_ORCH_PORT };
  afterEach(() => {
    process.env.KICI_CONFIG_DIR = saved.cfg;
    process.env.KICI_LOCAL_ORCH_PORT = saved.op;
  });

  it('defaults planeRoot under ~/.kici/local', () => {
    delete process.env.KICI_CONFIG_DIR;
    expect(planeRoot()).toBe(path.join(os.homedir(), '.kici', 'local'));
  });

  it('honors KICI_CONFIG_DIR', () => {
    process.env.KICI_CONFIG_DIR = '/tmp/cfgx';
    expect(planeRoot()).toBe(path.join('/tmp/cfgx', 'local'));
  });

  it('planePaths are all under planeRoot', () => {
    process.env.KICI_CONFIG_DIR = '/tmp/cfgx';
    const p = planePaths();
    expect(p.pidfile).toBe(path.join('/tmp/cfgx', 'local', 'plane.pid'));
    expect(p.pgData).toBe(path.join('/tmp/cfgx', 'local', 'pgdata'));
    expect(p.stampFile).toBe(path.join('/tmp/cfgx', 'local', 'stamp.json'));
  });

  it('planePorts default and override', () => {
    delete process.env.KICI_LOCAL_ORCH_PORT;
    expect(planePorts().orchestrator).toBe(4319);
    process.env.KICI_LOCAL_ORCH_PORT = '5000';
    expect(planePorts().orchestrator).toBe(5000);
  });
});
