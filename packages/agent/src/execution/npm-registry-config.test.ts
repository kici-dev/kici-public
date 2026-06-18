import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyNpmRegistryConfig,
  redactNpmOutput,
  type NpmRegistrySpec,
} from './npm-registry-config.js';

let kiciDir: string;

beforeEach(async () => {
  kiciDir = await mkdtemp(join(tmpdir(), 'kici-npmrc-test-'));
});

afterEach(async () => {
  await rm(kiciDir, { recursive: true, force: true }).catch(() => {});
});

const reg = (overrides: Partial<NpmRegistrySpec> = {}): NpmRegistrySpec => ({
  url: 'https://npm.example.com/',
  alwaysAuth: true,
  token: 'tok-A',
  ...overrides,
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('applyNpmRegistryConfig', () => {
  it('is a no-op when nothing is supplied', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: undefined,
      installEnvSecrets: undefined,
      jobIdShort: '12345678',
    });
    expect(r.extraEnv).toEqual({});
    expect(r.tokensForRedaction).toEqual([]);
    expect(await fileExists(join(kiciDir, '.npmrc'))).toBe(false);
    await r.cleanup();
  });

  it('writes default registry + auth-token line and seeds env var', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [reg({ url: 'https://npm.example.com/' })],
      installEnvSecrets: undefined,
      jobIdShort: 'abcd1234',
    });
    const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    expect(npmrc).toContain('registry=https://npm.example.com/');
    expect(npmrc).toContain('//npm.example.com/:_authToken=${KICI_NPM_TOKEN_abcd1234_0}');
    expect(npmrc).toContain('//npm.example.com/:always-auth=true');
    expect(r.extraEnv).toEqual({ KICI_NPM_TOKEN_abcd1234_0: 'tok-A' });
    expect(r.tokensForRedaction).toEqual(['tok-A']);
    await r.cleanup();
  });

  it('uses scope-prefixed registry line when scope is set', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [
        reg({
          url: 'https://npm.example.com/',
          scope: '@acme',
          alwaysAuth: false,
          token: 'tok-acme',
        }),
      ],
      installEnvSecrets: undefined,
      jobIdShort: 'abcd1234',
    });
    const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    expect(npmrc).toContain('@acme:registry=https://npm.example.com/');
    expect(npmrc).not.toContain('always-auth=true');
    await r.cleanup();
  });

  it('preserves the customer-committed .npmrc body, agent lines appended', async () => {
    await writeFile(join(kiciDir, '.npmrc'), 'audit=false\n${MY_TOKEN}\n');
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [reg()],
      installEnvSecrets: undefined,
      jobIdShort: 'abcd1234',
    });
    const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    expect(npmrc.startsWith('audit=false\n${MY_TOKEN}\n')).toBe(true);
    expect(npmrc).toContain('# kici-managed:');
    await r.cleanup();
    // After cleanup, original content is restored verbatim.
    const restored = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    expect(restored).toBe('audit=false\n${MY_TOKEN}\n');
  });

  it('appends a missing trailing newline before the agent block', async () => {
    await writeFile(join(kiciDir, '.npmrc'), 'foo=bar');
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [reg()],
      installEnvSecrets: undefined,
      jobIdShort: 'abcd1234',
    });
    const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    expect(npmrc.startsWith('foo=bar\n# kici-managed:')).toBe(true);
    await r.cleanup();
  });

  it('cleanup unlinks the file when no original existed', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [reg()],
      installEnvSecrets: undefined,
      jobIdShort: 'abcd1234',
    });
    expect(await fileExists(join(kiciDir, '.npmrc'))).toBe(true);
    await r.cleanup();
    expect(await fileExists(join(kiciDir, '.npmrc'))).toBe(false);
  });

  it('merges installEnvSecrets into extraEnv and adds them to redaction', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: undefined,
      installEnvSecrets: { MY_TOKEN: 'env-token-bytes' },
      jobIdShort: 'abcd1234',
    });
    expect(r.extraEnv).toEqual({ MY_TOKEN: 'env-token-bytes' });
    expect(r.tokensForRedaction).toEqual(['env-token-bytes']);
    // No registries means no .npmrc was rewritten.
    expect(await fileExists(join(kiciDir, '.npmrc'))).toBe(false);
    await r.cleanup();
  });

  it('emits a placeholder for every synthesized token (npm leaves ${VAR} literal when missing)', async () => {
    const r = await applyNpmRegistryConfig({
      kiciDir,
      npmRegistries: [
        reg({ url: 'https://r1.example.com/', token: 't1' }),
        reg({ url: 'https://r2.example.com/', token: 't2', scope: '@b' }),
      ],
      installEnvSecrets: undefined,
      jobIdShort: 'JOB12345',
    });
    const npmrc = await readFile(join(kiciDir, '.npmrc'), 'utf8');
    // Every emitted ${VAR} placeholder must have a matching extraEnv entry —
    // if any is missing, npm would write the literal `${VAR}` into the on-disk
    // resolved .npmrc and silently fail auth.
    const placeholders = [...npmrc.matchAll(/\$\{(KICI_NPM_TOKEN_[A-Za-z0-9_]+)\}/g)].map(
      (m) => m[1],
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const name of placeholders) {
      expect(r.extraEnv).toHaveProperty(name);
    }
    await r.cleanup();
  });
});

describe('redactNpmOutput', () => {
  it('replaces every token literal with ***REDACTED***', () => {
    const input = 'Failed: tried tok-A then tok-B; saw tok-A again';
    const out = redactNpmOutput(input, ['tok-A', 'tok-B']);
    expect(out).toBe('Failed: tried ***REDACTED*** then ***REDACTED***; saw ***REDACTED*** again');
  });
  it('returns input unchanged when token list is empty', () => {
    expect(redactNpmOutput('hello tok-A', [])).toBe('hello tok-A');
  });
  it('handles overlapping tokens (longer one masked correctly)', () => {
    // Even if a substring of one token equals another, both still mask.
    expect(redactNpmOutput('AAB', ['AA', 'B'])).toBe('***REDACTED******REDACTED***');
  });
  it('skips empty token strings', () => {
    expect(redactNpmOutput('hello', [''])).toBe('hello');
  });
});
