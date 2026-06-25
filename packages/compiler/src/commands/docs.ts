import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import open from 'open';
import { logger, toErrorMessage } from '@kici-dev/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCS_HOME_URL = 'https://kici.dev/docs/';

export interface DocsOptions {
  /** Open the docs site in the default browser. */
  open?: boolean;
}

export interface DocsLlmOptions {
  /** Task bundle id to print. Undefined → the llms.txt index; 'full' → llms-full.txt. */
  topic?: string;
  /** Override the bundled output destination (overrides default stdout). */
  out?: string;
  /** Override the directory holding the llms*.txt files (test seam). */
  bundleDir?: string;
}

function bundleFilenameForTopic(topic: string | undefined): string {
  if (!topic) return 'llms.txt';
  if (topic === 'full') return 'llms-full.txt';
  return `llms-${topic}.txt`;
}

async function availableTopics(bundleDir: string): Promise<string[]> {
  try {
    const names = await readdir(bundleDir);
    const ids = names
      .filter((n) => n.startsWith('llms-') && n.endsWith('.txt') && n !== 'llms-full.txt')
      .map((n) => n.slice('llms-'.length, -'.txt'.length));
    return [...ids.sort(), 'full'];
  } catch {
    return ['full'];
  }
}

/**
 * Open the published documentation site in the user's default browser.
 */
export async function docsCommand(options: DocsOptions = {}): Promise<boolean> {
  try {
    if (options.open === false) {
      logger.info(DOCS_HOME_URL);
      return true;
    }
    logger.info(pc.gray(`Opening ${DOCS_HOME_URL}`));
    await open(DOCS_HOME_URL);
    return true;
  } catch (error) {
    logger.error(pc.red(`Error: ${toErrorMessage(error)}`));
    logger.info(pc.gray(`Visit ${DOCS_HOME_URL} manually.`));
    return false;
  }
}

/**
 * Print a KiCI LLM docs bundle to stdout (or a file).
 *
 * No topic prints the llms.txt index (a router listing every task bundle).
 * A topic prints that task bundle (e.g. `sdk`, `cli`, `patterns`); `full`
 * prints the everything-bundle. Pipe straight into a coding agent's context
 * to brief it on KiCI authoring without an internet round-trip.
 */
export async function docsLlmCommand(options: DocsLlmOptions = {}): Promise<boolean> {
  const filename = bundleFilenameForTopic(options.topic);
  const bundleDir = options.bundleDir ?? path.join(__dirname, '..', 'llm-context');
  const bundlePath = path.join(bundleDir, filename);
  let content: string;
  try {
    content = await readFile(bundlePath, 'utf-8');
  } catch (error) {
    if (options.topic && options.topic !== 'full') {
      const topics = await availableTopics(bundleDir);
      logger.error(pc.red(`Unknown docs bundle "${options.topic}".`));
      logger.info(pc.gray(`Available topics: ${topics.join(', ')} (no topic prints the index).`));
      return false;
    }
    logger.error(pc.red(`Error reading bundled ${filename}: ${toErrorMessage(error)}`));
    logger.info(
      pc.gray(
        'The bundle ships with the @kici-dev/compiler package. If you built the package locally, run `pnpm build` in packages/compiler/.',
      ),
    );
    return false;
  }
  if (options.out) {
    await writeFile(options.out, content, 'utf-8');
    logger.info(pc.gray(`Wrote ${filename} to ${options.out}`));
    return true;
  }
  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
  return true;
}
