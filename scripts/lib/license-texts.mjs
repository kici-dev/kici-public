/**
 * License texts for npm packages that ship none: no license file in the
 * package, and no license section in its README. `scripts/package.mjs`
 * refuses to build a standalone package that carries such a dependency, unless
 * this map names it.
 *
 * Add an entry only after you read the package's source repository: take its
 * license file verbatim, and record where it came from. Each text lives in
 * `license-texts/`, beside this file. A key is a package name, or a prefix
 * ending in `*` for every package one repository publishes under it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TEXT_DIR = path.join(import.meta.dirname, 'license-texts');

/** npm package name or prefix → the text file and the URL it was taken from. */
export const LICENSE_TEXT_OVERRIDES = {
  // Every @aws-sdk package is published from the aws-sdk-js-v3 repository,
  // whose root LICENSE covers it. Some ship no copy of their own.
  '@aws-sdk/*': {
    file: 'aws-sdk-js-v3.LICENSE',
    source: 'https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE',
  },
  // The native builds of oxc-transform, published from the oxc repository. The
  // oxc-transform package ships the same LICENSE; its bindings ship none.
  '@oxc-transform/binding-*': {
    file: 'oxc.LICENSE',
    source: 'https://github.com/oxc-project/oxc/blob/main/LICENSE',
  },
  // Declares ISC; neither the package nor its repository has a license text.
  'split-ca': { file: 'split-ca.LICENSE', source: 'https://spdx.org/licenses/ISC.html' },
};

/** The entry for `name`: its exact key, else the prefix key that covers it. */
function overrideEntry(name) {
  if (Object.hasOwn(LICENSE_TEXT_OVERRIDES, name)) return LICENSE_TEXT_OVERRIDES[name];
  const prefix = Object.keys(LICENSE_TEXT_OVERRIDES).find(
    (key) => key.endsWith('*') && name.startsWith(key.slice(0, -1)),
  );
  return prefix === undefined ? null : LICENSE_TEXT_OVERRIDES[prefix];
}

/**
 * The committed license text for `name`, or null when the map has none.
 *
 * @param {string} name npm package name
 * @returns {{ origin: string, text: string } | null}
 */
export function overrideLicenseText(name) {
  const entry = overrideEntry(name);
  if (entry === null) return null;
  return {
    origin: `supplied by KiCI from ${entry.source} (the package ships no license text)`,
    text: readFileSync(path.join(TEXT_DIR, entry.file), 'utf-8'),
  };
}
