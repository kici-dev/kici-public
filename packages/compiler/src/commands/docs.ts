import { readFile, writeFile } from 'node:fs/promises';
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
  /** Print only the llms.txt index instead of the full markdown bundle. */
  index?: boolean;
  /** Override the bundled output destination (overrides default stdout). */
  out?: string;
  /** Override the directory holding llms.txt + llms-full.txt (test seam). */
  bundleDir?: string;
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
 * Print the bundled llms.txt or llms-full.txt content to stdout (or a file).
 *
 * The bundle is generated at build time by hack/postbuild.mjs and shipped at
 * dist/llm-context/{llms.txt,llms-full.txt}. Customer-facing LLM tools can
 * pipe `kici docs llm` straight into an Anthropic / OpenAI context buffer to
 * brief the agent on KiCI authoring conventions without an internet round-trip.
 */
export async function docsLlmCommand(options: DocsLlmOptions = {}): Promise<boolean> {
  const filename = options.index ? 'llms.txt' : 'llms-full.txt';
  const bundleDir = options.bundleDir ?? path.join(__dirname, '..', 'llm-context');
  const bundlePath = path.join(bundleDir, filename);
  try {
    const content = await readFile(bundlePath, 'utf-8');
    if (options.out) {
      await writeFile(options.out, content, 'utf-8');
      logger.info(pc.gray(`Wrote ${filename} to ${options.out}`));
      return true;
    }
    process.stdout.write(content);
    if (!content.endsWith('\n')) process.stdout.write('\n');
    return true;
  } catch (error) {
    logger.error(pc.red(`Error reading bundled ${filename}: ${toErrorMessage(error)}`));
    logger.info(
      pc.gray(
        'The bundle ships with the @kici-dev/compiler package. If you built the package locally, run `pnpm build` in packages/compiler/.',
      ),
    );
    return false;
  }
}
