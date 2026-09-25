/**
 * Read `.npmrc` files the way npm reads them, keep only allowlisted keys, and
 * write the result back as a fresh file.
 *
 * Raw lines are never copied. npm's `ini` parser splits a file on every run of
 * CR and LF, so a line that looks like one allowlisted key to a LF-only reader
 * can carry a second, arbitrary key after a lone CR. Parsing with npm's own
 * parser (loaded from the npm the host install runs) and serializing only the
 * kept pairs makes the file the package manager reads exactly the pairs this
 * module decided to keep. pnpm reads the written file with the same line
 * splitting.
 */

import { createRequire } from 'node:module';
import { resolveNpm } from './npm-resolver.js';

/** The subset of npm's `ini` module this module uses. */
export interface IniCodec {
  decode(text: string): Record<string, unknown>;
  encode(obj: Record<string, unknown>): string;
}

/** A kept `.npmrc` value: what npm's parser produces for a scalar or `key[]` line. */
export type NpmrcValue = string | boolean | string[];

/** Allowlisted `.npmrc` entries, keyed as npm's parser keys them. */
export type NpmrcEntries = Record<string, NpmrcValue>;

/**
 * Any control character except LF and TAB. A lone CR is one: npm's parser ends
 * a line on it, so it would start a new key inside what looks like one line.
 */
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Any control character at all: a kept value may carry none. */
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * npm's own `.npmrc` parser, from the npm bundled with the Node running the
 * agent. `null` when that npm is not found or ships no usable `ini`.
 */
export function loadNpmIni(): IniCodec | null {
  const { npmCliPath } = resolveNpm();
  if (!npmCliPath) return null;
  try {
    const ini = createRequire(npmCliPath)('ini') as Partial<IniCodec>;
    return typeof ini.decode === 'function' && typeof ini.encode === 'function'
      ? (ini as IniCodec)
      : null;
  } catch {
    return null;
  }
}

export type ParsedNpmrc =
  { ok: true; entries: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Parse a repository `.npmrc`. A file carrying a control character other than
 * LF or TAB is refused outright: a CR (including a CRLF line ending) is where a
 * second key would hide.
 */
export function parseRepoNpmrc(text: string, ini: IniCodec): ParsedNpmrc {
  // fails-when: a lone CR passes, so `registry=…\rhttps-proxy=…` reaches npm as
  // two keys while a LF-only reader saw one allowlisted line.
  // breaks-if-wrong: an ordinary LF-terminated file with TAB indentation parses.
  if (DISALLOWED_CONTROL.test(text)) {
    return { ok: false, reason: '.npmrc contains a control character other than LF or TAB' };
  }
  return { ok: true, entries: ini.decode(text) };
}

/** The top-level keys of parsed entries, lower-cased. */
export function npmrcKeys(entries: Record<string, unknown>): string[] {
  return Object.keys(entries).map((k) => k.toLowerCase());
}

/** `.npmrc` keys the repository may set: registries and their auth. */
export function isRepoNpmrcKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === 'registry' ||
    k === 'always-auth' ||
    /^@[a-z0-9][\w.-]*:registry$/.test(k) ||
    /^\/\/[^\s=]+:(_authtoken|_auth|username|_password|always-auth)$/.test(k)
  );
}

/** Keys only the operator's own config may set: TLS trust and proxies. */
const OPERATOR_ONLY_KEYS = new Set([
  'strict-ssl',
  'ca',
  'cafile',
  'proxy',
  'https-proxy',
  'noproxy',
  'no-proxy',
]);

/** `.npmrc` keys the operator's own config may set. */
export function isOperatorNpmrcKey(key: string): boolean {
  return isRepoNpmrcKey(key) || OPERATOR_ONLY_KEYS.has(key.toLowerCase());
}

function isCleanString(value: unknown): value is string {
  return typeof value === 'string' && !ANY_CONTROL.test(value);
}

/**
 * The top-level entries whose key passes `allow` and whose value is a boolean,
 * a string, or a list of strings, none carrying a control character. Section
 * contents are never kept.
 */
export function pickAllowed(
  entries: Record<string, unknown>,
  allow: (key: string) => boolean,
): NpmrcEntries {
  const kept: NpmrcEntries = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!allow(key) || ANY_CONTROL.test(key)) continue;
    if (typeof value === 'boolean' || isCleanString(value)) {
      kept[key] = value;
    } else if (Array.isArray(value) && value.length > 0 && value.every(isCleanString)) {
      kept[key] = value;
    }
  }
  return kept;
}

/** A per-registry credential key: `//host/path/:_authToken`, `_auth`, `username`, `_password`. */
const AUTH_KEY = /^\/\/[^\s=]+:(_authtoken|_auth|username|_password)$/i;

/**
 * The environment variable names the kept registry-auth values reference as
 * `${…}`, the form npm and pnpm expand when they read an `.npmrc`. Each
 * reference yields every name either tool may read for it: the whole text,
 * npm's `${NAME?}` without its `?`, and pnpm's `${NAME-default}` /
 * `${NAME:-default}` up to the dash.
 */
export function authEnvReferences(entrySets: readonly NpmrcEntries[]): Set<string> {
  const names = new Set<string>();
  for (const entries of entrySets) {
    for (const [key, value] of Object.entries(entries)) {
      if (!AUTH_KEY.test(key)) continue;
      for (const text of Array.isArray(value) ? value : [String(value)]) {
        for (const match of text.matchAll(/\$\{([^${}]+)\}/g)) {
          const inner = match[1]!;
          names.add(inner);
          names.add(inner.replace(/\?$/, ''));
          const defaulted = /^([^:-]+):?-/.exec(inner);
          if (defaulted) names.add(defaulted[1]!);
        }
      }
    }
  }
  return names;
}

/**
 * Namespaces of variables Node, npm, pnpm, corepack, libuv, OpenSSL, the
 * dynamic linker, git, node-gyp and their loggers read.
 */
const TOOL_ENV_PREFIXES = [
  'NODE_',
  'NPM_',
  'PNPM_',
  'PNP_',
  'COREPACK_',
  'UV_',
  'SSL_',
  'OPENSSL_',
  'LD_',
  'DYLD_',
  'XDG_',
  'LC_',
  'GIT_',
  'SSH_',
  'GYP_',
  'PYTHON',
  'LOG_',
];

/** Single variables the same tools read: proxies, paths, the shell, locale and config roots. */
const TOOL_ENV_NAMES = new Set([
  'PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'NO_PROXY',
  'NOPROXY',
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'LANG',
  'TZ',
  'PWD',
  'INIT_CWD',
  'PREFIX',
  'DESTDIR',
  'NODE',
  'LIBC',
  'CI',
  'MAKE',
  'JOBS',
  'EDITOR',
  'VISUAL',
  'BROWSER',
  'ENV',
  'ZDOTDIR',
  'ELECTRON_RUN_AS_NODE',
  'PREBUILDS_ONLY',
  'TERM',
]);

/**
 * Names inside a tool namespace above that no tool reads: npm 11.12.1, pnpm
 * 11.3.0 and Node 24 read neither. They are the names registry-auth lines
 * conventionally reference. Matched in this exact case only, since npm reads
 * its `npm_config_*` variables in any case.
 */
const TOOL_ENV_EXEMPT = new Set(['NPM_TOKEN', 'NODE_AUTH_TOKEN']);

/** A portable environment variable name: letters, digits and `_`, not starting with a digit. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `name` is a portable environment variable name. */
export function isEnvVarName(name: string): boolean {
  return ENV_NAME.test(name);
}

/**
 * Whether the runtime or a package manager reads `name` from its environment,
 * in any letter case: a proxy, a TLS trust root, a module preload, a config
 * root, a debug switch. Such a name must never reach the host install as an
 * install secret, where it would change what the install contacts, trusts or
 * loads. `NPM_TOKEN` and `NODE_AUTH_TOKEN`, in exactly that case, are not.
 */
export function isToolReadEnvName(name: string): boolean {
  // fails-when: `NPM_TOKEN` falls through to the `NPM_` prefix rule and refuses
  // breaks-if-wrong: `npm_token` and `NPM_TOKEN_FILE` still reach the prefix rule
  if (TOOL_ENV_EXEMPT.has(name)) return false;
  const upper = name.toUpperCase();
  return (
    TOOL_ENV_NAMES.has(upper) ||
    upper.includes('DEBUG') ||
    TOOL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** The public npm registry: npm rewrites lockfile URLs on it to the configured registry. */
export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/** Whether `key` names a registry: `registry` or `@scope:registry`. */
export function isRegistryKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === 'registry' || /^@[a-z0-9][\w.-]*:registry$/.test(k);
}

/** A registry URL parsed for prefix matching, or `null` when it does not parse. */
function registryBase(url: string): URL | null {
  try {
    const parsed = new URL(url.endsWith('/') ? url : `${url}/`);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

/** The origin of an http(s) registry URL, or `null` for anything else. */
export function registryOrigin(url: string): string | null {
  return registryBase(url)?.origin ?? null;
}

/**
 * The registries the host install may contact: the public npm registry, the
 * operator's `KICI_HOST_INSTALL_REGISTRIES` origins, and the default and
 * scoped registries of `entrySets` (the operator's own config). Neither a
 * workflow's `registries:` nor a repository's config is an input.
 */
export function allowedRegistries(
  entrySets: readonly NpmrcEntries[],
  operatorOrigins: readonly string[],
): URL[] {
  const urls = [NPM_PUBLIC_REGISTRY, ...operatorOrigins];
  for (const entries of entrySets) {
    for (const [key, value] of Object.entries(entries)) {
      if (isRegistryKey(key) && typeof value === 'string') urls.push(value);
    }
  }
  return urls.map(registryBase).filter((u): u is URL => u !== null);
}

/**
 * Whether `url` is a package tarball served by one of `registries`: same
 * origin, under the registry's path, and shaped `…/<name>/-/<file>.tgz`.
 */
export function isRegistryTarball(url: string, registries: readonly URL[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/\/-\/[^/]+\.tgz$/.test(parsed.pathname)) return false;
  // fails-when: any host is accepted, so a lockfile points the host install at
  // an agent-loopback or internal URL.
  // breaks-if-wrong: a tarball on a configured registry, or on the public npm
  // registry the lockfile was written against, still passes.
  return registries.some(
    (r) => parsed.origin === r.origin && parsed.pathname.startsWith(r.pathname),
  );
}

/**
 * Serialize the install's `.npmrc`: operator entries, then repository entries
 * (a repository key replaces the operator's), each written by npm's own
 * encoder, then the agent-managed registry block, whose lines npm reads last.
 */
export function serializeNpmrc(
  ini: IniCodec,
  operator: NpmrcEntries,
  repo: NpmrcEntries,
  agentBlock: string,
): string {
  const merged: Record<string, unknown> = { ...operator, ...repo };
  const body = ini.encode(merged);
  return `${body}${body && !body.endsWith('\n') ? '\n' : ''}${agentBlock}`;
}
