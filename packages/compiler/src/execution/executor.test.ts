import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeConfig } from './executor.js';
import { isCompilerError, type CompilerError } from '../errors/index.js';

describe('executeConfig module-load errors', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create the temp dir inside the package so @kici-dev/sdk resolves.
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-exec-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('E003 module-load failure reports the throwing line, not line 1', async () => {
    const configPath = path.join(tempDir, 'boom.ts');
    // Line 1: an export; line 2: a top-level throw. The E003 location must
    // anchor to line 2, not the hardcoded line 1.
    await fs.writeFile(
      configPath,
      `export const x = 1;\nthrow new Error('boom at line 2');\n`,
      'utf-8',
    );

    let thrown: unknown;
    try {
      await executeConfig(configPath);
    } catch (e) {
      thrown = e;
    }

    expect(isCompilerError(thrown)).toBe(true);
    const err = thrown as CompilerError;
    expect(err.code).toBe('E003');
    expect(err.location?.file).toBe(configPath);
    expect(err.location?.line).toBe(2);
  });
});
