// Shared LLM context generator. Reads markdown sources under docs/ and emits
// the llms.txt index plus the llms-full.txt concatenated bundle following the
// https://llmstxt.org/ convention. Used by both the compiler postbuild step
// (to bundle the offline bundle into dist/llm-context/) and the docs-site
// Astro integration (to publish llms.txt + llms-full.txt at the docs root).

import fs from 'node:fs/promises';
import path from 'node:path';

// Canonical public docs host. This generator ships to customers (compiler
// postbuild + `kici docs llm`) and never sees the KICI_DOCS_* env vars, so it
// uses a fixed prod base. The docs-site duplicate
// (docs-site/src/integrations/llm-context.ts) derives its base from those env
// vars instead, so the deployed site is self-consistent per host; both emit
// docs.kici.dev for prod.
const SITE_BASE_URL = 'https://docs.kici.dev';

function docsUrl(slugPath) {
  const tail = slugPath.replace(/^\//, '');
  return `${SITE_BASE_URL}/${tail}`;
}

// Top-level files under docs/user/ that are intentionally NOT included in the
// LLM bundle. Add a basename here if a doc is e.g. operator-leaning even
// though it lives under docs/user/, or otherwise inappropriate for the LLM
// authoring audience. The coverage test in hack/llm-context.test.ts fails
// the build if a new top-level docs/user/*.md isn't either listed in a
// SCOPE_GROUPS only: list or in this set — so adding a doc forces an
// explicit decision about whether it belongs in the bundle.
export const EXCLUDED_FROM_LLM_BUNDLE = new Set([]);

export const SCOPE_GROUPS = [
  {
    label: 'Getting started',
    dir: 'docs/user',
    recurse: false,
    only: ['quickstart.md', 'getting-started.md', 'README.md', 'README-public.md'],
  },
  {
    label: 'Workflow patterns',
    dir: 'docs/user/patterns',
    recurse: true,
  },
  {
    label: 'SDK reference',
    dir: 'docs/user/sdk',
    recurse: true,
    extras: [{ dir: 'docs/user', only: ['sdk-reference.md'] }],
  },
  {
    label: 'CLI and authoring',
    dir: 'docs/user',
    recurse: false,
    only: [
      'cli-reference.md',
      'cli-auth.md',
      'testing-guide.md',
      'hooks.md',
      'lock-file-and-drift.md',
      'workflow-patterns.md',
    ],
  },
  {
    label: 'Workflow features',
    dir: 'docs/user',
    recurse: false,
    only: [
      'concurrency.md',
      'environments.md',
      'dynamic-values.md',
      'events.md',
      'secrets.md',
      'private-registries.md',
      'env-vars.md',
      'global-workflows.md',
      'dashboard.md',
      'account-and-login.md',
      'approvals.md',
      'provenance.md',
    ],
  },
  {
    label: 'Providers',
    dir: 'docs/user/providers',
    recurse: true,
  },
  {
    label: 'Architecture overview',
    dir: 'docs/architecture',
    recurse: false,
    only: ['overview.md', 'design-decisions.md', 'data-flows.md'],
  },
];

function stripFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1]] = value;
  }
  return { frontmatter, body };
}

function relPathToSlug(repoRoot, absPath) {
  const rel = path.relative(path.join(repoRoot, 'docs'), absPath);
  const noExt = rel.replace(/\.(md|mdx)$/, '');
  return noExt.replace(/\\/g, '/');
}

function slugToUrl(slug) {
  const lower = slug.toLowerCase();
  if (lower.endsWith('/readme')) {
    return docsUrl(`${lower.slice(0, -'/readme'.length)}/`);
  }
  if (lower === 'readme') return docsUrl('');
  return docsUrl(`${lower}/`);
}

async function listMarkdown(absDir, recurse) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) {
        const nested = await listMarkdown(full, true);
        out.push(...nested);
      }
      continue;
    }
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
    out.push(full);
  }
  return out.sort();
}

async function filterFiles(absDir, recurse, only) {
  const all = await listMarkdown(absDir, recurse);
  if (!only) return all;
  const allowed = new Set(only);
  return all.filter((f) => allowed.has(path.basename(f)));
}

async function loadDoc(filePath, repoRoot) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const { frontmatter, body } = stripFrontmatter(raw);
  const slug = relPathToSlug(repoRoot, filePath);
  const url = slugToUrl(slug);
  const title = frontmatter.title || slug;
  const description = frontmatter.description || '';
  return { slug, url, title, description, body, filePath };
}

async function collectGroupDocs(repoRoot, group) {
  const seen = new Set();
  const docs = [];
  const dir = path.join(repoRoot, group.dir);
  const primary = await filterFiles(dir, group.recurse, group.only);
  for (const file of primary) {
    if (seen.has(file)) continue;
    seen.add(file);
    docs.push(await loadDoc(file, repoRoot));
  }
  if (group.extras) {
    for (const extra of group.extras) {
      const extraDir = path.join(repoRoot, extra.dir);
      const extraFiles = await filterFiles(extraDir, false, extra.only);
      for (const file of extraFiles) {
        if (seen.has(file)) continue;
        seen.add(file);
        docs.push(await loadDoc(file, repoRoot));
      }
    }
  }
  return docs;
}

function renderIndex(groups) {
  const lines = [];
  lines.push('# KiCI');
  lines.push('');
  lines.push(
    '> KiCI is a TypeScript-native CI/CD workflow engine. Workflows are defined in TypeScript (not YAML), compiled into a portable lock file, and executed by self-hosted agents. The docs below cover the SDK, the CLI, workflow patterns, and the runtime architecture an LLM coding agent needs in order to author and test KiCI workflows.',
  );
  lines.push('');
  lines.push(
    `The full markdown bundle of every page indexed here is available at ${SITE_BASE_URL}/llms-full.txt.`,
  );
  lines.push('');
  for (const group of groups) {
    if (group.docs.length === 0) continue;
    lines.push(`## ${group.label}`);
    lines.push('');
    for (const doc of group.docs) {
      const summary = doc.description ? `: ${doc.description}` : '';
      lines.push(`- [${doc.title}](${doc.url})${summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderFull(groups) {
  const lines = [];
  lines.push('# KiCI documentation bundle');
  lines.push('');
  lines.push(
    'This file is the concatenated markdown of every KiCI documentation page intended for LLM coding agents. See the index at /llms.txt for the same content as a curated link list.',
  );
  lines.push('');
  for (const group of groups) {
    if (group.docs.length === 0) continue;
    lines.push(`# ${group.label}`);
    lines.push('');
    for (const doc of group.docs) {
      lines.push(`## ${doc.title}`);
      lines.push('');
      lines.push(`Source: ${doc.url}`);
      lines.push('');
      lines.push(doc.body.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function generateLlmContext(repoRoot) {
  const groups = [];
  for (const groupSpec of SCOPE_GROUPS) {
    const docs = await collectGroupDocs(repoRoot, groupSpec);
    groups.push({ label: groupSpec.label, docs });
  }
  const llmsTxt = renderIndex(groups);
  const llmsFullTxt = renderFull(groups);
  return { llmsTxt, llmsFullTxt, groups };
}

export async function writeLlmContext(repoRoot, outDir) {
  const { llmsTxt, llmsFullTxt } = await generateLlmContext(repoRoot);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'llms.txt'), llmsTxt, 'utf-8');
  await fs.writeFile(path.join(outDir, 'llms-full.txt'), llmsFullTxt, 'utf-8');
  return { llmsTxt, llmsFullTxt };
}
