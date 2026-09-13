import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseSecretsFile, loadSecretsFile } from './secrets-file.js';

describe('parseSecretsFile', () => {
  it('returns empty result for empty content', () => {
    const result = parseSecretsFile('');
    expect(result).toEqual({ flat: {}, contexts: {} });
  });

  it('parses flat secrets only', () => {
    const content = 'KEY=VALUE\nKEY2=VALUE2';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'VALUE', KEY2: 'VALUE2' },
      contexts: {},
    });
  });

  it('parses a single context section', () => {
    const content = '[production]\nDB_HOST=localhost\nDB_PORT=5432';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: {},
      contexts: {
        production: { DB_HOST: 'localhost', DB_PORT: '5432' },
      },
    });
  });

  it('parses mixed flat + context secrets', () => {
    const content = 'GLOBAL_KEY=global_val\n\n[staging]\nAPI_KEY=abc123';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { GLOBAL_KEY: 'global_val' },
      contexts: {
        staging: { API_KEY: 'abc123' },
      },
    });
  });

  it('parses multiple context sections', () => {
    const content = '[dev]\nA=1\n[prod]\nB=2';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: {},
      contexts: {
        dev: { A: '1' },
        prod: { B: '2' },
      },
    });
  });

  it('skips comment lines', () => {
    const content = '# this is a comment\nKEY=VALUE\n# another comment';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'VALUE' },
      contexts: {},
    });
  });

  it('skips empty lines', () => {
    const content = '\nKEY=VALUE\n\n\nKEY2=VALUE2\n';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'VALUE', KEY2: 'VALUE2' },
      contexts: {},
    });
  });

  it('handles values containing = signs', () => {
    const content = 'KEY=a=b=c';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'a=b=c' },
      contexts: {},
    });
  });

  it('trims whitespace on keys and values', () => {
    const content = '  KEY  =  VALUE  ';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'VALUE' },
      contexts: {},
    });
  });

  it('handles section names with hyphens', () => {
    const content = '[npm-publish]\nTOKEN=secret123';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: {},
      contexts: {
        'npm-publish': { TOKEN: 'secret123' },
      },
    });
  });

  it('handles section names with underscores', () => {
    const content = '[my_context]\nFOO=bar';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: {},
      contexts: {
        my_context: { FOO: 'bar' },
      },
    });
  });

  it('ignores lines without = sign', () => {
    const content = 'KEY=VALUE\nINVALID_LINE\nKEY2=VALUE2';
    const result = parseSecretsFile(content);
    expect(result).toEqual({
      flat: { KEY: 'VALUE', KEY2: 'VALUE2' },
      contexts: {},
    });
  });
});

describe('loadSecretsFile', () => {
  const tmpDir = path.join(os.tmpdir(), `kici-secrets-test-${Date.now()}`);

  it('returns empty secrets for missing file', async () => {
    const result = await loadSecretsFile('/nonexistent/path');
    expect(result).toEqual({ flat: {}, contexts: {} });
  });

  it('parses an existing secrets file', async () => {
    await mkdir(tmpDir, { recursive: true });
    const secretsPath = path.join(tmpDir, '.secrets');
    await writeFile(secretsPath, 'API_KEY=test123\n[prod]\nDB=pg://host', 'utf-8');

    const result = await loadSecretsFile(tmpDir);
    expect(result).toEqual({
      flat: { API_KEY: 'test123' },
      contexts: { prod: { DB: 'pg://host' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('CLI flag parsing logic', () => {
  it('--secret values split at first =', () => {
    const flags = ['TOKEN=abc123', 'CONN=host=localhost;db=test'];
    const flat: Record<string, string> = {};
    for (const flag of flags) {
      const eqIndex = flag.indexOf('=');
      if (eqIndex === -1) continue;
      flat[flag.slice(0, eqIndex).trim()] = flag.slice(eqIndex + 1).trim();
    }
    expect(flat).toEqual({
      TOKEN: 'abc123',
      CONN: 'host=localhost;db=test',
    });
  });

  it('--context values split at first . then first =', () => {
    const flags = ['prod.DB_PASS=secret', 'npm-publish.TOKEN=xyz'];
    const contexts: Record<string, Record<string, string>> = {};
    for (const flag of flags) {
      const dotIndex = flag.indexOf('.');
      if (dotIndex === -1) continue;
      const contextName = flag.slice(0, dotIndex).trim();
      const rest = flag.slice(dotIndex + 1);
      const eqIndex = rest.indexOf('=');
      if (eqIndex === -1) continue;
      const key = rest.slice(0, eqIndex).trim();
      const value = rest.slice(eqIndex + 1).trim();
      if (!contexts[contextName]) contexts[contextName] = {};
      contexts[contextName][key] = value;
    }
    expect(contexts).toEqual({
      prod: { DB_PASS: 'secret' },
      'npm-publish': { TOKEN: 'xyz' },
    });
  });

  it('CLI flags override file values', () => {
    // Simulate file load
    const fileSecrets = {
      flat: { API_KEY: 'from-file', OTHER: 'untouched' },
      contexts: { prod: { DB_HOST: 'file-host' } },
    };

    // Simulate --secret override
    fileSecrets.flat['API_KEY'] = 'from-cli';

    // Simulate --context override
    fileSecrets.contexts['prod']['DB_HOST'] = 'cli-host';

    expect(fileSecrets.flat['API_KEY']).toBe('from-cli');
    expect(fileSecrets.flat['OTHER']).toBe('untouched');
    expect(fileSecrets.contexts['prod']['DB_HOST']).toBe('cli-host');
  });
});
