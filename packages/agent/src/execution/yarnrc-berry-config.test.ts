import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyYarnrcBerryConfig } from './yarnrc-berry-config.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('applyYarnrcBerryConfig', () => {
  it('always forces nodeLinker:node-modules and an isolated cache folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-yrc-'));
    const res = await applyYarnrcBerryConfig({
      kiciDir: dir,
      npmRegistries: [],
      installEnvSecrets: {},
      jobIdShort: 'abc123de',
    });
    const doc = parse(await readFile(join(dir, '.yarnrc.yml'), 'utf-8')) as Record<string, unknown>;
    expect(doc.nodeLinker).toBe('node-modules');
    expect(doc.enableGlobalCache).toBe(false);
    expect(typeof doc.cacheFolder).toBe('string');
    await res.cleanup();
  });

  it('renders npmScopes auth as ${ENV} references (token never on disk)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-yrc-'));
    const res = await applyYarnrcBerryConfig({
      kiciDir: dir,
      npmRegistries: [
        { url: 'https://npm.acme.test/', scope: 'acme', alwaysAuth: true, token: 'SECRET-TOKEN' },
      ],
      installEnvSecrets: {},
      jobIdShort: 'abc123de',
    });
    const raw = await readFile(join(dir, '.yarnrc.yml'), 'utf-8');
    expect(raw).not.toContain('SECRET-TOKEN');
    expect(raw).toContain('${KICI_NPM_TOKEN_abc123de_0}');
    expect(raw).toContain('enableScripts: false');
    expect(res.extraEnv.KICI_NPM_TOKEN_abc123de_0).toBe('SECRET-TOKEN');
    expect(res.tokensForRedaction).toContain('SECRET-TOKEN');
    const doc = parse(raw) as { npmScopes?: Record<string, { npmAlwaysAuth?: boolean }> };
    expect(doc.npmScopes?.acme?.npmAlwaysAuth).toBe(true);
    await res.cleanup();
  });

  it('deep-merges over a committed .yarnrc.yml and restores it on cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-yrc-'));
    const original = 'nodeLinker: pnp\nyarnPath: .yarn/releases/yarn-4.1.0.cjs\n';
    await writeFile(join(dir, '.yarnrc.yml'), original);
    const res = await applyYarnrcBerryConfig({
      kiciDir: dir,
      npmRegistries: [],
      installEnvSecrets: {},
      jobIdShort: 'abc123de',
    });
    const merged = parse(await readFile(join(dir, '.yarnrc.yml'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(merged.nodeLinker).toBe('node-modules'); // agent key wins
    expect(merged.yarnPath).toBe('.yarn/releases/yarn-4.1.0.cjs'); // customer key preserved
    await res.cleanup();
    expect(await readFile(join(dir, '.yarnrc.yml'), 'utf-8')).toBe(original); // restored verbatim
  });

  it('removes the synthesized file on cleanup when none existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-yrc-'));
    const res = await applyYarnrcBerryConfig({
      kiciDir: dir,
      npmRegistries: [],
      installEnvSecrets: {},
      jobIdShort: 'abc123de',
    });
    expect(await exists(join(dir, '.yarnrc.yml'))).toBe(true);
    await res.cleanup();
    expect(await exists(join(dir, '.yarnrc.yml'))).toBe(false);
  });
});
