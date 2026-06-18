#!/usr/bin/env node
/**
 * Postinstall wrapper script for @kici-dev/compiler
 *
 * This wrapper:
 * 1. Detects development mode (KICI_DEV env or kici.development in root package.json)
 * 2. Skips postinstall in dev mode (prevents "Cannot find dist/postinstall.mjs" errors)
 * 3. Delegates to dist/postinstall.mjs in production mode
 *
 * Purpose: Allow `pnpm install` to succeed even when dist/ hasn't been built yet
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Detect if running in development mode
 *
 * Development mode is used when developing KiCI itself.
 * Checks:
 * 1. KICI_DEV environment variable
 * 2. Root package.json kici.development flag
 *
 * @returns {Promise<boolean>} true if in development mode
 */
async function detectDevelopmentMode() {
  // Method 1: Environment variable
  if (process.env.KICI_DEV === 'true') {
    if (process.env.KICI_DEBUG === 'true') {
      console.log('[postinstall] Skipping: KICI_DEV=true');
    }
    return true;
  }

  // Method 2: Check root package.json for kici.development flag
  // During npm/pnpm install, INIT_CWD contains the original working directory (project root)
  try {
    const rootDir = process.env.INIT_CWD || process.cwd();
    const rootPkgPath = path.join(rootDir, 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content);

    if (pkg.kici?.development === true) {
      if (process.env.KICI_DEBUG === 'true') {
        console.log('[postinstall] Skipping: kici.development=true in root package.json');
      }
      return true;
    }
  } catch {
    // Root package.json doesn't exist or can't be read
  }

  return false;
}

/**
 * Run the actual postinstall script
 *
 * @returns {Promise<void>}
 */
function runPostinstall() {
  return new Promise((resolve, reject) => {
    const postinstallPath = path.join(__dirname, '..', 'dist', 'postinstall.js');

    const child = spawn('node', [postinstallPath], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`postinstall.mjs exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  try {
    // Skip in development mode
    if (await detectDevelopmentMode()) {
      return;
    }

    // Run the actual postinstall
    await runPostinstall();
  } catch (err) {
    // Silently fail - postinstall should not break npm install
    if (process.env.KICI_DEBUG === 'true') {
      console.error('[postinstall] Error:', err.message);
    }
  }
}

main();
