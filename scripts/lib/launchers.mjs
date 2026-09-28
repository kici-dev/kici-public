/**
 * Launcher scripts for the KiCI packages built by `scripts/package.mjs`.
 *
 * A full package's launcher runs its own `bin/node`. A light package's
 * launcher runs the Node.js binary cached for the package's Node version:
 *
 * - Linux and macOS: `${XDG_CACHE_HOME:-$HOME/.cache}/kici/node-binaries/v<version>/bin/node`
 * - Windows: `%LOCALAPPDATA%\kici\node-binaries\v<version>\node.exe`
 *
 * That cache is the official Node.js archive for the version, extracted in
 * place, so npm sits beside the binary where the agent's builder role looks
 * for it. When the binary is missing, the light launcher prints how to create
 * the cache for its own platform and exits 1.
 */

/** @param {string} targetName */
export function fullUnixLauncher(targetName) {
  return `#!/bin/sh
exec "$(dirname "$0")/bin/node" "$(dirname "$0")/lib/${targetName}.cjs" "$@"
`;
}

/** @param {string} targetName */
export function fullWindowsLauncher(targetName) {
  return `@"%~dp0\\bin\\node.exe" "%~dp0\\lib\\${targetName}.cjs" %*\r\n`;
}

/**
 * @param {string} targetName
 * @param {string} version the Node.js version the package runs on
 * @param {{ os: string, arch: string }} platform
 */
export function lightUnixLauncher(targetName, version, platform) {
  const archive = `node-v${version}-${platform.os}-${platform.arch}.tar.gz`;
  return `#!/bin/sh
KICI_CACHE="\${XDG_CACHE_HOME:-\$HOME/.cache}/kici/node-binaries/v${version}"
NODE="\$KICI_CACHE/bin/node"
if [ ! -x "\$NODE" ]; then
  echo "Error: Node.js v${version} not found at \$NODE" >&2
  echo "Extract the official Node.js v${version} archive, which includes npm, into \$KICI_CACHE:" >&2
  echo "  mkdir -p \\"\$KICI_CACHE\\"" >&2
  echo "  curl -fsSL https://nodejs.org/dist/v${version}/${archive} | tar -xz --strip-components=1 -C \\"\$KICI_CACHE\\"" >&2
  echo "The KiCI packaging guide shows how to verify the archive checksum first." >&2
  exit 1
fi
exec "\$NODE" "$(dirname "$0")/lib/${targetName}.cjs" "$@"
`;
}

/**
 * cmd.exe expands `%VAR%` before it parses a line, so a profile path holding
 * `(`, `)` or `&` would otherwise become syntax. Each expansion of the cache
 * path is quoted, and the hint runs at top level through GOTO rather than
 * inside an IF block, whose parsing a `)` would end early even when Node is
 * present.
 *
 * @param {string} targetName
 * @param {string} version the Node.js version the package runs on
 * @param {{ os: string, arch: string }} platform
 */
export function lightWindowsLauncher(targetName, version, platform) {
  const folder = `node-v${version}-${platform.os}-${platform.arch}`;
  return [
    `@SET "KICI_CACHE=%LOCALAPPDATA%\\kici\\node-binaries\\v${version}"`,
    `@IF EXIST "%KICI_CACHE%\\node.exe" GOTO run`,
    `@echo Error: Node.js v${version} not found at "%KICI_CACHE%\\node.exe" >&2`,
    `@echo Download https://nodejs.org/dist/v${version}/${folder}.zip, which includes npm. >&2`,
    `@echo Copy the contents of its ${folder} folder into "%KICI_CACHE%" >&2`,
    `@exit /b 1`,
    `:run`,
    `@"%KICI_CACHE%\\node.exe" "%~dp0\\lib\\${targetName}.cjs" %*`,
    '',
  ].join('\r\n');
}
