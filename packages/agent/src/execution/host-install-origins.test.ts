import { describe, it, expect } from 'vitest';
import {
  parseHostInstallRegistries,
  parseRegistryOrigin,
  redactRegistryEntry,
} from './host-install-origins.js';

describe('parseRegistryOrigin', () => {
  it.each([
    ['http://verdaccio.local:4873', 'http://verdaccio.local:4873'],
    ['http://verdaccio.local:4873/', 'http://verdaccio.local:4873'],
    ['HTTP://Verdaccio.Local:4873', 'http://verdaccio.local:4873'],
    ['https://npm.acme.internal:443/', 'https://npm.acme.internal'],
    ['http://192.168.1.50:4873', 'http://192.168.1.50:4873'],
    ['http://[::1]:4873', 'http://[::1]:4873'],
    ['http://my_verdaccio:4873', 'http://my_verdaccio:4873'],
  ])('normalizes %j to %j', (entry, origin) => {
    // breaks-if-wrong: the same origin in any spelling the URL standard folds
    // together parses, so an operator's entry matches the registries it names.
    expect(parseRegistryOrigin(entry)).toEqual({ ok: true, origin });
  });

  it.each([
    'verdaccio.local:4873',
    'verdaccio.local',
    'file:///srv/npm',
    'ftp://mirror.example',
    'http://verdaccio.local:4873/npm/',
    'https://npm.acme.internal/?token=x',
    'https://npm.acme.internal/#x',
    'https://user:pass@npm.acme.internal',
    'http://${REGISTRY_HOST}:4873',
    'not a url',
  ])('refuses %j', (entry) => {
    // fails-when: an entry naming more or less than an http(s) origin is
    // accepted, so the operator's list does not mean what it says.
    expect(parseRegistryOrigin(entry)).toMatchObject({ ok: false });
  });
});

describe('parseHostInstallRegistries', () => {
  it('splits on commas, skips blanks, dedupes and reports each invalid entry', () => {
    expect(
      parseHostInstallRegistries(
        ' http://verdaccio.local:4873 ,, http://VERDACCIO.local:4873/,ftp://x,https://npm.acme.internal',
      ),
    ).toEqual({
      origins: ['http://verdaccio.local:4873', 'https://npm.acme.internal'],
      invalid: [{ entry: 'ftp://x', reason: 'is not an http or https URL' }],
    });
    expect(parseHostInstallRegistries('')).toEqual({ origins: [], invalid: [] });
  });

  it('reports an invalid entry without the credentials it carries', () => {
    // fails-when: the refused entry is reported verbatim, so the startup error
    // echoes the registry password into the agent's log.
    expect(parseHostInstallRegistries('https://ci:s3cret@npm.acme.internal').invalid).toEqual([
      { entry: 'https://npm.acme.internal', reason: 'carries credentials' },
    ]);
  });
});

describe('redactRegistryEntry', () => {
  it.each([
    ['https://ci:s3cret@npm.acme.internal', 'https://npm.acme.internal'],
    ['https://ci:p@ss@npm.acme.internal:4873', 'https://npm.acme.internal:4873'],
    ['https://tok3n@npm.acme.internal', 'https://npm.acme.internal'],
    ['ci:s3cret@verdaccio.local:4873', 'verdaccio.local:4873'],
    ['//ci:s3cret@verdaccio.local', '//verdaccio.local'],
    ['https://npm.acme.internal/?token=s3cret', 'https://npm.acme.internal/?[redacted]'],
    ['https://npm.acme.internal/#s3cret', 'https://npm.acme.internal/#[redacted]'],
  ])('removes the credentials from %j', (entry, redacted) => {
    // fails-when: userinfo, a query or a fragment survives into the error message
    expect(redactRegistryEntry(entry)).toBe(redacted);
  });

  it.each(['http://verdaccio.local:4873/npm/', 'verdaccio.local:4873', 'ftp://mirror.example'])(
    'keeps %j, which carries no credentials, as written',
    (entry) => {
      // breaks-if-wrong: an entry refused for its path or scheme is still named
      // exactly, so the operator can find it in the setting.
      expect(redactRegistryEntry(entry)).toBe(entry);
    },
  );
});
