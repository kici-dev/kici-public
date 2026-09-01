import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
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

  it('resolves a symlinked local dir to its durable target', () => {
    // `pnpm deploy:stg` runs against a throwaway config dir that only symlinks
    // `local` at the real plane, so it carries no credentials while still
    // reusing the warm plane. Postgres is started with a data directory under
    // whatever planeRoot() returns and keeps it OPEN — so if it returned the
    // ephemeral path, the caller removing its temp dir would PANIC the running
    // Postgres ("could not open file .../pgdata/global/pg_control") and shut
    // the whole plane down under every later phase.
    const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-plane-real-'));
    const durableLocal = path.join(durable, 'local');
    fs.mkdirSync(durableLocal);

    const ephemeral = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-plane-tmp-'));
    fs.symlinkSync(durableLocal, path.join(ephemeral, 'local'));

    process.env.KICI_CONFIG_DIR = ephemeral;
    try {
      expect(planeRoot()).toBe(fs.realpathSync(durableLocal));
      // And the data directory Postgres is handed follows it.
      expect(planePaths().pgData).toBe(path.join(fs.realpathSync(durableLocal), 'pgdata'));
    } finally {
      fs.rmSync(ephemeral, { recursive: true, force: true });
      fs.rmSync(durable, { recursive: true, force: true });
    }
  });

  it('leaves a not-yet-created root as itself, so a fresh plane can make it', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-plane-fresh-'));
    process.env.KICI_CONFIG_DIR = base;
    try {
      expect(planeRoot()).toBe(path.join(base, 'local'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
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
