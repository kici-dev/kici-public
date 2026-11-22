/**
 * Which rolldown platform a package builds for, and the check that keeps browser-bundled
 * output free of node built-ins.
 *
 * Under `platform: 'node'`, rolldown adds a runtime helper that imports `node:module` (for
 * `createRequire`), and with tree-shaking off that import stays even when nothing calls
 * `require`. A browser bundler cannot resolve it: Vite only warns and replaces it with an
 * empty stub. Code the dashboard bundles therefore builds for `'neutral'`, which adds no
 * node runtime helper and still runs on Node.
 */

/** The platforms a package may declare in `build.platform`. */
export const BUILD_PLATFORMS = ['node', 'neutral'];

/**
 * Whether built code carries a static `import … "node:…"` statement.
 *
 * @param {string} code
 * @returns {boolean}
 */
export const importsNodeBuiltin = (code) => /^\s*import\b[^;]*["']node:/m.test(code);

/**
 * The library platform a package declares in `build.platform`, `'node'` when unset.
 *
 * @param {{ build?: { platform?: unknown } }} pkg the package's package.json
 * @returns {'node' | 'neutral'}
 */
export function resolveLibraryPlatform(pkg) {
  const platform = pkg.build?.platform ?? 'node';
  if (!BUILD_PLATFORMS.includes(platform)) {
    throw new Error(
      `"build.platform" is ${JSON.stringify(platform)}; expected one of ${BUILD_PLATFORMS.join(', ')}`,
    );
  }
  return platform;
}

/**
 * The generated (non-entry) chunks that import a node built-in. A source file may import
 * one on purpose (a Node-only subpath); a chunk rolldown generates, such as its runtime
 * helper, must not when the package builds for a browser.
 *
 * @param {ReadonlyArray<{ type: string, isEntry?: boolean, fileName: string, code?: string }>} output
 * @returns {string[]} the offending chunk file names
 */
export function generatedChunksImportingNode(output) {
  return output
    .filter((item) => item.type === 'chunk' && !item.isEntry && importsNodeBuiltin(item.code ?? ''))
    .map((item) => item.fileName);
}
