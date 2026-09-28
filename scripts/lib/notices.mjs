/**
 * The license, notice and source files at the root of every standalone
 * package, and the check that a built archive carries them.
 *
 * - `LICENSE`: the license of the component the package ships.
 * - `LICENSES.md`: the repository's per-package license matrix.
 * - `THIRD-PARTY-NOTICES`: every package whose code is in the archive — the
 *   packages the bundler inlined, read from its output, and the packages
 *   installed beside the bundle — with the license each declares and the
 *   license text it carries. A package with no license text fails the build.
 * - `SOURCE`: where to get the source code of the release.
 * - `NODE-LICENSE`: in full packages only, the `LICENSE` file of the official
 *   Node.js archive the package embeds, which also covers the npm it bundles.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { overrideLicenseText } from './license-texts.mjs';

export const LICENSE_FILE = 'LICENSE';
export const LICENSES_MATRIX_FILE = 'LICENSES.md';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES';
export const SOURCE_FILE = 'SOURCE';
export const NODE_LICENSE_FILE = 'NODE-LICENSE';

const PUBLIC_REPO_URL = 'https://github.com/kici-dev/kici-public';

/**
 * The files at the root of a package of `type`: all but `NODE-LICENSE` in a
 * light package, which embeds no Node.js.
 *
 * @param {'full' | 'light'} type
 */
export function requiredPackageFiles(type) {
  const files = [LICENSE_FILE, LICENSES_MATRIX_FILE, NOTICES_FILE, SOURCE_FILE];
  return type === 'full' ? [...files, NODE_LICENSE_FILE] : files;
}

/** The archive paths of every file this module governs, under `<dirName>/`. */
export function packageFilePaths(dirName) {
  return requiredPackageFiles('full').map((f) => `${dirName}/${f}`);
}

// ─── Which package a bundled module belongs to ───────────────────────────────

/**
 * The directory of the npm package a bundled module comes from.
 *
 * Under `node_modules/` it is the package right after the last `node_modules`
 * segment, so a nested `package.json` inside a package cannot split it.
 * Elsewhere (a workspace package) it is the nearest directory up whose
 * `package.json` has a name. A bundler-generated module (`\0…`) maps to the
 * directory `virtualDirs` names for its prefix, and any other one is refused:
 * code with no known origin has no license to name.
 *
 * @param {string} id a module id from the bundler's output
 * @param {{ virtualDirs?: Record<string, string> }} [opts] generated-module
 *   id → the package directory that generates it
 */
export function packageDirOfModule(id, { virtualDirs = {} } = {}) {
  if (id.startsWith('\0')) {
    if (Object.hasOwn(virtualDirs, id)) return virtualDirs[id];
    throw new Error(
      `bundled module ${JSON.stringify(id)} has no package, so its license is unknown`,
    );
  }
  const file = id.split('?')[0].replaceAll('\\', '/');
  const marker = '/node_modules/';
  const at = file.lastIndexOf(marker);
  if (at >= 0) {
    const rest = file.slice(at + marker.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    return file.slice(0, at + marker.length) + name;
  }
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf-8')).name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`bundled module ${file} is in no package, so its license is unknown`);
    }
    dir = parent;
  }
}

/** A package.json `license` field, or the legacy `licenses` list, as one expression. */
function declaredLicense(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === 'string') return license;
  if (license && typeof license.type === 'string') return license.type;
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return 'not declared';
}

// ─── License texts ───────────────────────────────────────────────────────────

const LICENSE_FILE_PATTERN = /^(?:(?:un)?licen[cs]e|copying)(?:[.\-_][a-z0-9]+)*$/i;
const NOTICE_FILE_PATTERN = /^notice(?:[.\-_][a-z0-9]+)*$/i;
/** A license-named file with one of these extensions is data or code, not a license text. */
const NOT_A_TEXT = /\.(?:[cm]?js|[cm]?ts|json|csv|html?|ya?ml|xml|sh)$/i;
const README_PATTERN = /^readme(?:\.(?:md|markdown|txt))?$/i;
const LICENSE_HEADING = /^licen[cs]e\b/i;

/**
 * The body of a README's license section: from a heading that starts with
 * "License" or "Licence" to the next heading of the same or a higher level.
 * Returns null when there is none, or when the section holds no copyright
 * notice (a bare "MIT" names a license but gives no text).
 *
 * @param {string} markdown
 */
export function readmeLicenseSection(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const headingAt = (i) => {
    const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (atx) return { level: atx[1].length, text: atx[2], span: 1 };
    const next = lines[i + 1];
    if (lines[i].trim() !== '' && next !== undefined && /^(=+|-+)\s*$/.test(next)) {
      return { level: next.startsWith('=') ? 1 : 2, text: lines[i].trim(), span: 2 };
    }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(i);
    if (!h || !LICENSE_HEADING.test(h.text)) continue;
    const body = [];
    let j = i + h.span;
    for (; j < lines.length; j++) {
      const inner = headingAt(j);
      if (inner && inner.level <= h.level) break;
      body.push(lines[j]);
    }
    const text = body.join('\n').trim();
    if (/copyright/i.test(text)) return text;
    i = j - 1;
  }
  return null;
}

/**
 * The license texts of the package in `dir`: its license and notice files;
 * without a license file, the license section of its README; without that,
 * the text `license-texts.mjs` supplies. Throws when none exists.
 *
 * @param {string} dir the package directory
 * @param {string} label `name@version`, for the error
 * @returns {Array<{ origin: string, text: string }>}
 */
export function licenseTexts(dir, label) {
  const names = readdirSync(dir)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();
  const read = (f) => readFileSync(path.join(dir, f), 'utf-8');
  const licenses = names.filter((f) => LICENSE_FILE_PATTERN.test(f) && !NOT_A_TEXT.test(f));
  const notices = names
    .filter((f) => NOTICE_FILE_PATTERN.test(f) && !NOT_A_TEXT.test(f))
    .map((f) => ({ origin: f, text: read(f) }));
  if (licenses.length > 0) {
    return [...licenses.map((f) => ({ origin: f, text: read(f) })), ...notices];
  }
  const readme = names.find((f) => README_PATTERN.test(f));
  const section = readme ? readmeLicenseSection(read(readme)) : null;
  if (section !== null) {
    return [{ origin: `${readme} (License section)`, text: section }, ...notices];
  }
  const name = JSON.parse(read('package.json')).name;
  const supplied = overrideLicenseText(name);
  if (supplied !== null) return [supplied, ...notices];
  throw new Error(
    `${label} ships no license text: no LICENSE, LICENCE or COPYING file and no License ` +
      `section with a copyright notice in its README (${dir}). Find the license in the ` +
      "package's source repository and add it to scripts/lib/license-texts.mjs.",
  );
}

// ─── Collecting the packages in an archive ───────────────────────────────────

/**
 * @typedef {{ name: string, version: string, license: string, dir: string,
 *   texts: Array<{ origin: string, text: string }> }} NoticePackage
 */

/** The package in `dir`, keyed `name@version`. */
function describePackage(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  const key = `${manifest.name}@${manifest.version}`;
  return {
    key,
    pkg: {
      name: manifest.name,
      version: manifest.version,
      license: declaredLicense(manifest),
      dir,
      texts: licenseTexts(dir, key),
    },
  };
}

/**
 * Every package the bundler put code from into a bundle, keyed
 * `name@version`, in first-seen order.
 *
 * @param {string[]} moduleIds the module ids of the bundle's chunks
 * @param {{ virtualDirs?: Record<string, string> }} [opts]
 * @returns {Map<string, NoticePackage>}
 */
export function collectBundledPackages(moduleIds, opts = {}) {
  const dirs = new Set(moduleIds.map((id) => packageDirOfModule(id, opts)));
  const found = new Map();
  for (const dir of dirs) {
    const { key, pkg } = describePackage(dir);
    if (!found.has(key)) found.set(key, pkg);
  }
  return found;
}

/**
 * Every package installed under `nodeModulesDir`, nested ones included. A
 * package whose name `workspaceDirs` maps is a KiCI package, described from
 * its workspace directory: the package manifest there carries the release
 * version and the license file.
 *
 * @param {string} nodeModulesDir
 * @param {Map<string, string>} workspaceDirs package name → workspace directory
 * @returns {Map<string, NoticePackage>}
 */
export function collectInstalledPackages(nodeModulesDir, workspaceDirs) {
  const found = new Map();
  const visit = (nm) => {
    if (!existsSync(nm)) return;
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith('.')) continue;
      const scoped = entry.startsWith('@');
      const dirs = scoped
        ? readdirSync(path.join(nm, entry)).map((n) => path.join(nm, entry, n))
        : [path.join(nm, entry)];
      for (const dir of dirs) {
        if (!existsSync(path.join(dir, 'package.json'))) continue;
        const name = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')).name;
        const { key, pkg } = describePackage(workspaceDirs.get(name) ?? dir);
        if (!found.has(key)) found.set(key, pkg);
        visit(path.join(dir, 'node_modules'));
      }
    }
  };
  visit(nodeModulesDir);
  return found;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const RULE = '='.repeat(80);
const THIN_RULE = '-'.repeat(80);

/** Line endings and trailing spaces do not make two license texts differ. */
function normalizeText(text) {
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * THIRD-PARTY-NOTICES for a package: one entry per package, sorted by name
 * and version. A text already printed, or equal to the package's own LICENSE,
 * is referred to instead of repeated.
 *
 * @param {{ component: string, version: string,
 *   packages: Map<string, NoticePackage>, licenseText: string }} opts
 */
export function renderNotices({ component, version, packages, licenseText }) {
  /** Normalized text → the sentence that refers to where it was printed. */
  const seen = new Map([
    [normalizeText(licenseText), 'The same text as the LICENSE file of this package.'],
  ]);
  const out = [
    'THIRD-PARTY NOTICES',
    '',
    `${component} ${version} contains code from the software packages below. Each entry names`,
    'a package, its version, the license the package declares, and the license text the',
    'package carries. The build writes this file from the files it puts into this package.',
    '',
    'LICENSE gives the license of this package. LICENSES.md explains how the KiCI packages are',
    'licensed.',
  ];
  const keys = [...packages.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) {
    const pkg = packages.get(key);
    out.push('', RULE, `Package: ${key}`, `License: ${pkg.license}`);
    for (const { origin, text } of pkg.texts) {
      out.push(`Text from: ${origin}`, THIN_RULE);
      const norm = normalizeText(text);
      const earlier = seen.get(norm);
      if (earlier !== undefined) {
        out.push(earlier);
      } else {
        seen.set(norm, `The same text as the entry for ${key} above.`);
        out.push(norm);
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The packages a THIRD-PARTY-NOTICES file names, each with the number of
 * license texts its entry carries. Only the header lines `renderNotices`
 * writes count: `Package:` right after a rule, and `Text from:` right before
 * a thin rule, so a license text that quotes such a line adds nothing.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function parseNoticesPackages(text) {
  const found = new Map();
  const lines = text.split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const pkg = /^Package: (\S+)$/.exec(lines[i]);
    if (pkg && lines[i - 1] === RULE) {
      current = pkg[1];
      found.set(current, 0);
    } else if (
      current !== null &&
      lines[i].startsWith('Text from: ') &&
      lines[i + 1] === THIN_RULE
    ) {
      found.set(current, found.get(current) + 1);
    }
  }
  return found;
}

/**
 * SOURCE: where the source code of the release is.
 *
 * @param {{ component: string, version: string, type: 'full' | 'light' }} opts
 */
export function renderSource({ component, version, type }) {
  const lines = [
    `${component} ${version}`,
    '',
    `The source code of this package is the kici-dev/kici-public repository at tag v${version}:`,
    '',
    `  ${PUBLIC_REPO_URL}/tree/v${version}`,
    '',
    'To download it as an archive:',
    '',
    `  ${PUBLIC_REPO_URL}/archive/refs/tags/v${version}.tar.gz`,
    '',
    'LICENSE gives the license of this package. LICENSES.md explains how the KiCI packages are',
    'licensed. THIRD-PARTY-NOTICES names the other software in this package and gives its',
    'licenses.',
  ];
  if (type === 'full') {
    lines.push(
      `${NODE_LICENSE_FILE} is the license of the Node.js runtime in this package and of the npm`,
      'it includes.',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── The archive check ───────────────────────────────────────────────────────

/** A bundle in a package: a script under lib/, outside the npm of Node.js. */
function isBundle(entry, dirName) {
  return (
    entry.startsWith(`${dirName}/lib/`) &&
    !entry.startsWith(`${dirName}/lib/node_modules/`) &&
    /\.c?js$/.test(entry)
  );
}

/** The manifest of a package installed beside the bundle, nested ones included. */
function isInstalledManifest(entry, dirName) {
  const rest = entry.slice(dirName.length + 1);
  return (
    entry.startsWith(`${dirName}/`) &&
    /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(rest)
  );
}

/**
 * The archive entries the check reads: the license, notice and source files,
 * the bundles, and the manifest of each installed package.
 *
 * @param {Set<string>} entries
 * @param {string} dirName
 */
export function archiveCheckPaths(entries, dirName) {
  const own = [...entries].filter((e) => isBundle(e, dirName) || isInstalledManifest(e, dirName));
  return [...packageFilePaths(dirName), ...own];
}

/**
 * The packages whose code an archive carries, read from the archive itself:
 * the `//#region <module>` marker rolldown writes before each module in a
 * bundle, and the manifests under the package's node_modules. It does not use
 * the list the notices were written from, so it catches a package that list
 * missed. The limit: rolldown writes no marker for a CommonJS module it inlines
 * into another module's region, so a package whose code is only inlined that
 * way is not seen here. A bundle module in no known package is a problem, and
 * so is a bundle with no marker, whose module list cannot be read.
 *
 * @param {{ archive: { entries: Set<string>, files: Map<string, Buffer> },
 *   dirName: string, root: string, virtualPackages: Record<string, string>,
 *   workspaceVersions: Map<string, string> }} opts
 *   `root` is the directory the bundler ran in, which region paths are
 *   relative to; `virtualPackages` maps a generated-module prefix to the
 *   `name@version` that generates it; `workspaceVersions` maps a KiCI package
 *   name to the release version.
 * @returns {{ keys: Set<string>, problems: string[] }}
 */
export function archivePackageInventory({
  archive,
  dirName,
  root,
  virtualPackages,
  workspaceVersions,
}) {
  const keys = new Set();
  const problems = [];
  const manifestKey = new Map();
  const keyOfDir = (dir) => {
    if (!manifestKey.has(dir)) {
      const file = path.resolve(root, dir, 'package.json');
      const m = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null;
      manifestKey.set(dir, m?.name && m?.version ? `${m.name}@${m.version}` : null);
    }
    return manifestKey.get(dir);
  };
  const regionKey = (marker) => {
    // A generated module's id starts with a NUL, which the marker writes as \0.
    const p = marker.startsWith('\\0') ? `\0${marker.slice(2)}` : marker;
    if (p.startsWith('\0')) {
      const prefix = Object.keys(virtualPackages).find((v) => p.startsWith(v));
      return prefix === undefined ? null : virtualPackages[prefix];
    }
    const at = p.lastIndexOf('node_modules/');
    if (at >= 0) {
      const [first, second] = p.slice(at + 'node_modules/'.length).split('/');
      return keyOfDir(
        p.slice(0, at) + `node_modules/${first.startsWith('@') ? `${first}/${second}` : first}`,
      );
    }
    const workspace = /^packages\/[^/]+/.exec(p);
    return workspace ? keyOfDir(workspace[0]) : null;
  };

  for (const entry of [...archive.files.keys()].sort()) {
    const rel = entry.slice(dirName.length + 1);
    const text = archive.files.get(entry).toString('utf-8');
    if (isBundle(entry, dirName)) {
      const modules = [...text.matchAll(/^\/\/#region (.+)$/gm)].map((m) => m[1]);
      if (modules.length === 0) {
        problems.push(`${rel} names no bundled module, so its packages cannot be checked`);
      }
      for (const module of new Set(modules)) {
        const key = regionKey(module);
        if (key === null) problems.push(`${rel} bundles ${module}, which is in no known package`);
        else keys.add(key);
      }
    } else if (isInstalledManifest(entry, dirName)) {
      const m = JSON.parse(text);
      keys.add(`${m.name}@${workspaceVersions.get(m.name) ?? m.version}`);
    }
  }
  return { keys, problems };
}

/**
 * What a built archive lacks: a required file (missing or empty), a Node.js
 * license in a light package, a package whose code the archive carries that
 * the notices do not name (`archivePackageInventory`), or a notices entry
 * without a license text. Empty when complete.
 *
 * @param {{ archive: { entries: Set<string>, files: Map<string, Buffer> },
 *   dirName: string, type: 'full' | 'light', root: string,
 *   virtualPackages: Record<string, string>,
 *   workspaceVersions: Map<string, string> }} opts
 * @returns {string[]}
 */
export function checkPackageArchive({
  archive,
  dirName,
  type,
  root,
  virtualPackages,
  workspaceVersions,
}) {
  const problems = [];
  for (const file of requiredPackageFiles(type)) {
    const name = `${dirName}/${file}`;
    if (!archive.entries.has(name)) problems.push(`${file} is missing`);
    else if ((archive.files.get(name)?.length ?? 0) === 0) problems.push(`${file} is empty`);
  }
  if (type === 'light' && archive.entries.has(`${dirName}/${NODE_LICENSE_FILE}`)) {
    problems.push(`${NODE_LICENSE_FILE} is in a light package, which carries no Node.js`);
  }
  const inventory = archivePackageInventory({
    archive,
    dirName,
    root,
    virtualPackages,
    workspaceVersions,
  });
  problems.push(...inventory.problems);
  const notices = archive.files.get(`${dirName}/${NOTICES_FILE}`);
  if (notices !== undefined && notices.length > 0) {
    const named = parseNoticesPackages(notices.toString('utf-8'));
    const omitted = [...inventory.keys].filter((key) => !named.has(key));
    if (omitted.length > 0) problems.push(`${NOTICES_FILE} omits ${omitted.join(', ')}`);
    for (const [key, texts] of named) {
      if (texts === 0) problems.push(`${NOTICES_FILE}: ${key} has no license text`);
    }
  }
  return problems;
}
