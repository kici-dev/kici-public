import { describe, it, expect } from 'vitest';
import {
  NPM_PUBLIC_REGISTRY,
  allowedRegistries,
  authEnvReferences,
  isOperatorNpmrcKey,
  isRegistryTarball,
  isRepoNpmrcKey,
  isToolReadEnvName,
  loadNpmIni,
  parseRepoNpmrc,
  pickAllowed,
  serializeNpmrc,
} from './npmrc-allowlist.js';

const ini = loadNpmIni();

/** A lone CR hides a second key inside what a LF-only reader sees as one line. */
const LONE_CR_PAYLOAD =
  'registry=https://registry.npmjs.org/\rhttps-proxy=http://attacker.example:8080/\n';

/** The raw-line copy the host install must never do: split on LF, keep allowlisted lines. */
function rawLineCopy(text: string, allow: (key: string) => boolean): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && allow(line.slice(0, line.indexOf('=')).trim()))
    .join('\n');
}

describe.skipIf(!ini)("npmrc allowlist (npm's own ini)", () => {
  const codec = ini!;

  it('refuses a lone CR, and the payload does smuggle a key through a raw-line copy', () => {
    // Positive control: a LF-only reader keeps the line as one `registry` pair,
    // and npm's parser reads a second key out of the copied bytes.
    const copied = rawLineCopy(LONE_CR_PAYLOAD, isRepoNpmrcKey);
    expect(copied).toContain('https-proxy');
    expect(codec.decode(copied)['https-proxy']).toBe('http://attacker.example:8080/');

    // fails-when: the CR is accepted, so the smuggled key reaches the install.
    expect(parseRepoNpmrc(LONE_CR_PAYLOAD, codec)).toMatchObject({ ok: false });
  });

  it.each([
    ['a CRLF line ending', 'registry=https://r.example/\r\n'],
    ['a vertical tab', 'registry=https://r.example/\u000bx=y\n'],
    ['a NUL byte', 'registry=https://r.example/\u0000\n'],
    ['a DEL byte', 'registry=https://r.example/\u007f\n'],
  ])('refuses %s', (_name, text) => {
    expect(parseRepoNpmrc(text, codec)).toMatchObject({ ok: false });
  });

  it('parses an ordinary file with LF endings, TAB indentation and comments', () => {
    // breaks-if-wrong: a plain .npmrc must still parse, keys as npm keys them.
    const parsed = parseRepoNpmrc(
      '# comment\n\tregistry = https://r.example/\n; other\n@acme:registry=https://a.example/\n',
      codec,
    );
    expect(parsed).toEqual({
      ok: true,
      entries: { registry: 'https://r.example/', '@acme:registry': 'https://a.example/' },
    });
  });

  it('keeps only allowlisted top-level pairs whose values carry no control character', () => {
    const entries = codec.decode(
      [
        '@acme:registry=https://npm.acme.internal/',
        '//npm.acme.internal/:_authToken=${ACME_TOKEN}',
        '//npm.acme.internal/:_auth=dXNlcjpwYXNz==',
        'always-auth=true',
        'strict-ssl=false',
        'ca[]=-----BEGIN CERTIFICATE-----',
        'cafile=/etc/shadow',
        'proxy=http://attacker.example:8080',
        'node-options=--require ./evil.cjs',
        'git=./evil.sh',
        'script-shell=./evil.sh',
        // A quoted value is JSON-decoded, so an escaped CR becomes a real one.
        'registry="https://r.example/\\rnode-options=--require ./evil.cjs"',
        '[section]',
        'registry=https://in-a-section.example/',
      ].join('\n'),
    );
    expect(entries.registry).toContain('\r');

    // fails-when: a code-loading key, a TLS or proxy key, a section, or a value
    // carrying a CR from a quoted escape survives the repository allowlist.
    expect(pickAllowed(entries, isRepoNpmrcKey)).toEqual({
      '@acme:registry': 'https://npm.acme.internal/',
      '//npm.acme.internal/:_authToken': '${ACME_TOKEN}',
      '//npm.acme.internal/:_auth': 'dXNlcjpwYXNz==',
      'always-auth': true,
    });
    // breaks-if-wrong: the operator's own config keeps TLS trust and proxies.
    expect(pickAllowed(entries, isOperatorNpmrcKey)).toMatchObject({
      'strict-ssl': false,
      ca: ['-----BEGIN CERTIFICATE-----'],
      cafile: '/etc/shadow',
      proxy: 'http://attacker.example:8080',
    });
  });

  it('serializes only the kept pairs, which npm reads back exactly', () => {
    const operator = { proxy: 'http://proxy.corp:3128', ca: ['a', 'b'], 'strict-ssl': false };
    const repo = {
      registry: 'https://r.example/',
      '//r.example/:_auth': 'dXNlcjpwYXNz==',
      '//r.example/:_authToken': '${TOK}',
    };
    const agentBlock = '# kici-managed\n@acme:registry=https://npm.acme.internal/\n';
    const text = serializeNpmrc(codec, operator, repo, agentBlock);

    // fails-when: the written file carries a pair npm decodes differently from
    // what was kept (a lost `=` in a base64 value, a split array).
    expect(codec.decode(text)).toEqual({
      ...operator,
      ...repo,
      '@acme:registry': 'https://npm.acme.internal/',
    });
    expect(text.endsWith(agentBlock)).toBe(true);
    // A repository pair replaces the operator's for the same key.
    expect(codec.decode(serializeNpmrc(codec, { registry: 'o' }, { registry: 'r' }, ''))).toEqual({
      registry: 'r',
    });
  });
});

describe('isRegistryTarball', () => {
  const registries = allowedRegistries(
    [{ registry: 'https://npm.acme.internal/npm/' }, { '@s:registry': 'http://verdaccio:4873' }],
    ['https://operator.example'],
  );

  it.each([
    'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
    'https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz',
    'https://npm.acme.internal/npm/a/-/a-1.0.0.tgz',
    'http://verdaccio:4873/@s/b/-/b-2.0.0.tgz',
    'https://operator.example/c/-/c-3.0.0.tgz',
  ])('accepts a tarball on an allowed registry: %s', (url) => {
    // breaks-if-wrong: an ordinary registry lockfile stays eligible.
    expect(isRegistryTarball(url, registries)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:9000/a/-/a-1.0.0.tgz',
    'http://localhost/a/-/a-1.0.0.tgz',
    'http://169.254.169.254/a/-/a-1.0.0.tgz',
    'http://registry.npmjs.org/a/-/a-1.0.0.tgz',
    'https://npm.acme.internal/other/a/-/a-1.0.0.tgz',
    'http://verdaccio:4874/@s/b/-/b-2.0.0.tgz',
    'https://registry.npmjs.org/a/-/a-1.0.0.tar',
    'git+https://registry.npmjs.org/a.git',
    'not a url',
  ])('refuses a URL off the allowed registries: %s', (url) => {
    // fails-when: any host is accepted, so the host npm fetches an
    // agent-loopback or metadata URL named by the repository's lockfile.
    expect(isRegistryTarball(url, registries)).toBe(false);
  });

  it('always includes the public npm registry and ignores unusable registry values', () => {
    const urls = allowedRegistries([{ registry: 'file:///etc/', ca: 'x' }], []).map((u) => u.href);
    expect(urls).toEqual([NPM_PUBLIC_REGISTRY]);
  });
});

describe('authEnvReferences', () => {
  it('collects the names npm and pnpm read from kept auth values only', () => {
    const names = authEnvReferences([
      {
        '//a.example/:_authToken': '${NPM_STYLE}',
        '//b.example/:_auth': '${OPTIONAL?}',
        '//c.example/:_password': '${PNPM_DASH-fallback}',
        '//d.example/:username': ['${COLON_DASH:-fallback}'],
        registry: 'https://r.example/${REGISTRY_PATH}/',
        '//e.example/:always-auth': true,
      },
    ]);
    // fails-when: a reference in a non-auth value (a registry path) is passed
    // into the install env, or a pnpm `${NAME-default}` / npm `${NAME?}` form
    // hides the name the tool actually reads.
    expect([...names].sort()).toEqual(
      [
        'COLON_DASH',
        'COLON_DASH:-fallback',
        'NPM_STYLE',
        'OPTIONAL',
        'OPTIONAL?',
        'PNPM_DASH',
        'PNPM_DASH-fallback',
      ].sort(),
    );
  });
});

describe('isToolReadEnvName', () => {
  it.each([
    'HTTPS_PROXY',
    'proxy',
    'https_proxy',
    'HTTP_PROXY',
    'NO_PROXY',
    'no_proxy',
    'ALL_PROXY',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_USE_ENV_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'OPENSSL_CONF',
    'npm_config_registry',
    'NPM_CONFIG_GLOBALCONFIG',
    'PNPM_HOME',
    'COREPACK_HOME',
    'LD_PRELOAD',
    'PREFIX',
    'HOME',
    'PATH',
    'DEBUG',
    'NOPT_DEBUG',
  ])('treats %s as read by the runtime or a package manager', (name) => {
    // fails-when: an install secret under this name reaches the install env,
    // where it reroutes, re-trusts or preloads the package manager.
    expect(isToolReadEnvName(name)).toBe(true);
  });

  it.each(['MY_NPM_TOKEN', 'ACME_TOKEN', 'GITHUB_PACKAGES_TOKEN', 'KICI_NPM_TOKEN_job12345_0'])(
    'passes the plain secret name %s',
    (name) => {
      // breaks-if-wrong: the documented installEnv names keep the host install.
      expect(isToolReadEnvName(name)).toBe(false);
    },
  );

  it.each(['NPM_TOKEN', 'NODE_AUTH_TOKEN'])(
    'passes %s, which no tool reads, although its prefix is a tool namespace',
    (name) => {
      // fails-when: the NPM_ / NODE_ prefix rule is checked before the exemption,
      // so the conventional registry-token name moves the install into the container.
      expect(isToolReadEnvName(name)).toBe(false);
    },
  );

  it.each([
    'npm_token',
    'Node_Auth_Token',
    'NPM_TOKEN_FILE',
    'NODE_AUTH_TOKEN_X',
    'NPM_CONFIG_TOKEN',
  ])('keeps %s in its tool namespace: the exemption matches the exact name only', (name) => {
    // breaks-if-wrong: the exemption stays exact-case, so a name npm could read
    // as config (npm_config_* in any case) or a longer NPM_ name is still refused.
    expect(isToolReadEnvName(name)).toBe(true);
  });
});
