import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import open from 'open';
import { docsUrl, logger, toErrorMessage } from '@kici-dev/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCS_HOME_URL = docsUrl('');

export interface DocsOptions {
  open?: boolean;
}

export interface DocsLlmOptions {
  /** Undefined → the llms.txt index; 'full' → llms-full.txt. */
  topic?: string;
  /** Defaults to stdout. */
  out?: string;
  /** Test seam for the directory holding the llms*.txt files. */
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

/** `open: false` prints the URL instead of opening a browser. */
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
 * Print an LLM docs bundle, for a coding agent's context without an internet
 * round-trip. No topic prints the llms.txt index of task bundles; a topic
 * (e.g. `sdk`) prints that bundle; `full` prints everything.
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
