#!/usr/bin/env node
/**
 * Post-install script for @kici-dev/compiler
 *
 * Prompts users to run `kici init` after installing the package.
 * Skips in CI environments, non-TTY, dev mode, and if .kici/ already exists.
 */

import { confirm } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Detect if running in development mode
 *
 * Development mode is used when developing KiCI itself.
 * Checks:
 * 1. KICI_DEV environment variable
 * 2. Root package.json kici.development flag
 *
 * @returns true if in development mode
 */
async function detectDevelopmentMode(): Promise<boolean> {
  // Method 1: Environment variable
  if (process.env.KICI_DEV === 'true') {
    return true;
  }

  // Method 2: Check root package.json for kici.development flag
  // During npm/pnpm install, INIT_CWD contains the original working directory (project root)
  try {
    const rootDir = process.env.INIT_CWD || process.cwd();
    const rootPkgPath = path.join(rootDir, 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { development?: boolean } };
    return pkg.kici?.development === true;
  } catch {
    // Root package.json doesn't exist or can't be read
    return false;
  }
}

async function main() {
  // Skip in development mode (avoids circular dependency issues)
  if (await detectDevelopmentMode()) {
    return;
  }

  // Skip in CI environments or non-TTY
  if (process.env.CI === 'true' || !process.stdout.isTTY) {
    return;
  }

  // Skip if already initialized (check for .kici directory)
  const fs = await import('node:fs/promises');
  try {
    await fs.access('.kici');
    // .kici already exists, skip prompt
    return;
  } catch {
    // .kici doesn't exist, proceed with prompt
  }

  console.log('\n');

  const shouldInit = await confirm({
    message: 'Would you like to initialize .kici/ directory now?',
    default: true,
  });

  if (shouldInit) {
    console.log('\nRunning kici init...\n');
    // Run kici init using the CLI binary
    const child = spawn('npx', ['kici', 'init'], {
      stdio: 'inherit',
      shell: true,
    });

    child.on('error', (err) => {
      console.error('Failed to run kici init:', err.message);
    });
  } else {
    console.log('\nYou can run "npx kici init" later to set up workflows.\n');
  }
}

main().catch(() => {
  // Silently fail - postinstall should not break npm install
});
