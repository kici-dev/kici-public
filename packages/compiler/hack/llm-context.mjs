// Shared LLM context generator. Reads markdown sources under docs/ and emits
// the llms.txt index plus the llms-full.txt concatenated bundle following the
// https://llmstxt.org/ convention. Used by both the compiler postbuild step
// (to bundle the offline bundle into dist/llm-context/) and the docs-site
// Astro integration (to publish llms.txt + llms-full.txt at the docs root).

import fs from 'node:fs/promises';
import path from 'node:path';

// Canonical public docs host used when no base is supplied (the compiler
// postbuild ships to customers and always emits prod URLs). The docs-site
// Astro integration passes its own env-derived base instead, so the
// deployed site is self-consistent per host.
const DEFAULT_SITE_BASE_URL = 'https://docs.kici.dev';

function docsUrl(slugPath, siteBaseUrl) {
  const base = siteBaseUrl.replace(/\/$/, '');
  const tail = slugPath.replace(/^\//, '');
  return tail ? `${base}/${tail}` : `${base}/`;
}

// Files/subdirs under docs/user/ intentionally NOT in the LLM authoring
// bundles. An entry ending in '/' excludes every file beneath that
// repo-relative directory. docs/user/dashboard/ is dashboard UI-usage
// documentation and docs/user/quickstart/ is install/deploy guidance — both
// are user-facing but neither is workflow-authoring content, the audience of
// these bundles. The deepened coverage check in hack/llm-context.test.ts
// fails the build if a new docs/user path is neither bundled nor excluded
// here, forcing an explicit decision about whether it belongs in a bundle.
export const EXCLUDED_FROM_LLM_BUNDLE = new Set(['docs/user/dashboard/', 'docs/user/quickstart/']);

// Per-task bundle size budget. A task bundle over this is a signal to split
// the group — keeping each bundle small enough to drop into an LLM context
// for one task. The full bundle (llms-full.txt) is exempt by design.
export const MAX_BUNDLE_BYTES = 200_000;

export const SCOPE_GROUPS = [
  {
    id: 'getting-started',
    label: 'Getting started',
    purpose: 'Install the SDK, write your first workflow, compile and test locally',
    dir: 'docs/user',
    recurse: false,
    only: ['quickstart.md', 'getting-started.md', 'README.md', 'README-public.md'],
  },
  {
    id: 'patterns',
    label: 'Workflow patterns',
    purpose:
      'Copy-paste workflow recipes: triggers, conditionals, matrix, scheduling, integrations',
    dir: 'docs/user/patterns',
    recurse: true,
  },
  {
    id: 'sdk',
    label: 'SDK reference',
    purpose:
      'Authoring API: workflow/job/step factories, triggers, rules, matrix, runtime, caching',
    dir: 'docs/user/sdk',
    recurse: true,
    extras: [{ dir: 'docs/user', only: ['sdk-reference.md'] }],
  },
  {
    id: 'cli',
    label: 'CLI and authoring',
    purpose: 'Running the CLI: compile, test, run local/remote, auth, hooks, lock-file drift',
    dir: 'docs/user',
    recurse: false,
    only: [
      'cli-reference.md',
      'cli-auth.md',
      'ai-agents.md',
      'testing-guide.md',
      'hooks.md',
      'lock-file-and-drift.md',
      'workflow-patterns.md',
    ],
  },
  {
    id: 'features',
    label: 'Workflow features',
    purpose: 'Workflow features: concurrency, environments, secrets, approvals, provenance, events',
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
      'idempotent-steps.md',
    ],
  },
  {
    id: 'providers',
    label: 'Providers',
    purpose: 'Connecting sources: GitHub App, universal-git (Forgejo/Gitea/GitLab), local file://',
    dir: 'docs/user/providers',
    recurse: true,
  },
  {
    id: 'architecture',
    label: 'Architecture overview',
    purpose: 'How the runtime works: three-tier relay model, data flows, configuration',
    dir: 'docs/architecture',
    recurse: false,
    only: ['overview.md', 'data-flows.md', 'configuration.md'],
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

function slugToUrl(slug, siteBaseUrl) {
  const lower = slug.toLowerCase();
  if (lower.endsWith('/readme')) {
    return docsUrl(`${lower.slice(0, -'/readme'.length)}/`, siteBaseUrl);
  }
  if (lower === 'readme') return docsUrl('', siteBaseUrl);
  return docsUrl(`${lower}/`, siteBaseUrl);
}

function pageUrl(sourceAbsPath, repoRoot, siteBaseUrl) {
  return slugToUrl(relPathToSlug(repoRoot, sourceAbsPath), siteBaseUrl);
}

function rewriteOneTarget(target, sourceAbsPath, repoRoot, siteBaseUrl) {
  // Split an optional markdown link title: `url "title"`.
  const spaceIdx = target.search(/\s/);
  const url = spaceIdx === -1 ? target : target.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : target.slice(spaceIdx);
  let out = url;
  if (/^(https?:|mailto:|tel:)/i.test(url)) {
    out = url;
  } else if (url.startsWith('#')) {
    out = `${pageUrl(sourceAbsPath, repoRoot, siteBaseUrl)}${url}`;
  } else if (url.startsWith('/')) {
    out = `${siteBaseUrl.replace(/\/$/, '')}${url}`;
  } else {
    const hashIdx = url.indexOf('#');
    const pathPart = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? '' : url.slice(hashIdx);
    if (/\.(md|mdx)$/.test(pathPart)) {
      const absTarget = path.resolve(path.dirname(sourceAbsPath), pathPart);
      out = `${slugToUrl(relPathToSlug(repoRoot, absTarget), siteBaseUrl)}${anchor}`;
    } else {
      out = url; // relative non-md target (asset / dir) — leave as-is
    }
  }
  return `${out}${rest}`;
}

export function rewriteLinks(body, sourceAbsPath, repoRoot, siteBaseUrl) {
  return body.replace(
    /\]\(([^)]+)\)/g,
    (_full, target) => `](${rewriteOneTarget(target, sourceAbsPath, repoRoot, siteBaseUrl)})`,
  );
}

export function findRelativeMdLinks(text) {
  const out = [];
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[1].split(/\s/)[0];
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) continue;
    if (/\.(md|mdx)(#.*)?$/.test(url)) out.push(url);
  }
  return out;
}

async function collectAllBundledFiles(repoRoot) {
  const files = new Set();
  for (const group of SCOPE_GROUPS) {
    const primary = await filterFiles(path.join(repoRoot, group.dir), group.recurse, group.only);
    for (const f of primary) files.add(f);
    for (const extra of group.extras ?? []) {
      const extraFiles = await filterFiles(path.join(repoRoot, extra.dir), false, extra.only);
      for (const f of extraFiles) files.add(f);
    }
  }
  return files;
}

export async function findDanglingRefs(repoRoot) {
  const out = [];
  const files = await collectAllBundledFiles(repoRoot);
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf-8');
    const { body } = stripFrontmatter(raw);
    for (const target of findRelativeMdLinks(body)) {
      const pathPart = target.split('#')[0];
      const absTarget = path.resolve(path.dirname(file), pathPart);
      try {
        await fs.access(absTarget);
      } catch {
        out.push({ source: path.relative(repoRoot, file), target });
      }
    }
  }
  return out;
}

export async function findUncoveredUserDocs(repoRoot) {
  const bundled = await collectAllBundledFiles(repoRoot);
  const userDir = path.join(repoRoot, 'docs', 'user');
  const all = await listMarkdown(userDir, true);
  // Directory-prefix excludes: any EXCLUDED_FROM_LLM_BUNDLE entry ending in
  // '/' excludes every file beneath that repo-relative directory.
  const dirExcludes = [...EXCLUDED_FROM_LLM_BUNDLE].filter((e) => e.endsWith('/'));
  const out = [];
  for (const file of all) {
    if (bundled.has(file)) continue;
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (EXCLUDED_FROM_LLM_BUNDLE.has(path.basename(file)) || EXCLUDED_FROM_LLM_BUNDLE.has(rel)) {
      continue;
    }
    if (dirExcludes.some((prefix) => rel.startsWith(prefix))) continue;
    out.push(rel);
  }
  return out;
}

export async function assertBundleQuality(repoRoot, result) {
  const rendered = [result.index, result.full, ...result.bundles.map((b) => b.content)];
  for (const text of rendered) {
    const bad = findRelativeMdLinks(text);
    if (bad.length > 0) {
      throw new Error(
        `llm-context: ${bad.length} relative .md link(s) survived rewriting: ${bad.slice(0, 5).join(', ')}`,
      );
    }
  }
  for (const b of result.bundles) {
    if (b.bytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `llm-context: bundle llms-${b.id}.txt is ${b.bytes} bytes > cap ${MAX_BUNDLE_BYTES}; split the "${b.label}" group`,
      );
    }
  }
  const dangling = await findDanglingRefs(repoRoot);
  if (dangling.length > 0) {
    const sample = dangling
      .slice(0, 5)
      .map((d) => `${d.source} -> ${d.target}`)
      .join('; ');
    throw new Error(
      `llm-context: ${dangling.length} dangling .md link(s) in source docs: ${sample}`,
    );
  }
  const uncovered = await findUncoveredUserDocs(repoRoot);
  if (uncovered.length > 0) {
    throw new Error(
      `llm-context: docs/user file(s) not in any bundle or EXCLUDED_FROM_LLM_BUNDLE: ${uncovered.join(', ')}`,
    );
  }
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

async function loadDoc(filePath, repoRoot, siteBaseUrl) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const { frontmatter, body } = stripFrontmatter(raw);
  const slug = relPathToSlug(repoRoot, filePath);
  const url = slugToUrl(slug, siteBaseUrl);
  const title = frontmatter.title || slug;
  const description = frontmatter.description || '';
  return {
    slug,
    url,
    title,
    description,
    body: rewriteLinks(body, filePath, repoRoot, siteBaseUrl),
    filePath,
  };
}

async function collectGroupDocs(repoRoot, group, siteBaseUrl) {
  const seen = new Set();
  const docs = [];
  const dir = path.join(repoRoot, group.dir);
  const primary = await filterFiles(dir, group.recurse, group.only);
  for (const file of primary) {
    if (seen.has(file)) continue;
    seen.add(file);
    docs.push(await loadDoc(file, repoRoot, siteBaseUrl));
  }
  if (group.extras) {
    for (const extra of group.extras) {
      const extraDir = path.join(repoRoot, extra.dir);
      const extraFiles = await filterFiles(extraDir, false, extra.only);
      for (const file of extraFiles) {
        if (seen.has(file)) continue;
        seen.add(file);
        docs.push(await loadDoc(file, repoRoot, siteBaseUrl));
      }
    }
  }
  return docs;
}

function renderIndex(groups, siteBaseUrl, bundles) {
  const lines = [];
  lines.push('# KiCI');
  lines.push('');
  lines.push(
    '> KiCI is a TypeScript-native CI/CD workflow engine. Workflows are defined in TypeScript (not YAML), compiled into a portable lock file, and executed by self-hosted agents. The docs below cover the SDK, the CLI, workflow patterns, and the runtime architecture an LLM coding agent needs in order to author and test KiCI workflows.',
  );
  lines.push('');
  lines.push(
    `The full markdown bundle of every page indexed here is available at ${docsUrl('llms-full.txt', siteBaseUrl)}.`,
  );
  lines.push('');
  lines.push('## Bundles');
  lines.push('');
  lines.push(
    'Each bundle below is a self-contained markdown file for one authoring task. Fetch only the one your task needs instead of the full bundle:',
  );
  lines.push('');
  for (const b of bundles) {
    const kb = (b.bytes / 1024).toFixed(0);
    lines.push(
      `- [${b.id}](${docsUrl(`llms-${b.id}.txt`, siteBaseUrl)}) (${kb} KB) — ${b.purpose}`,
    );
  }
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

function renderBundle(group) {
  const lines = [];
  lines.push(`# KiCI ${group.label}`);
  lines.push('');
  lines.push(`This bundle covers: ${group.purpose}.`);
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
  return lines.join('\n');
}

export async function generateLlmContext(repoRoot, opts = {}) {
  const siteBaseUrl = opts.siteBaseUrl ?? DEFAULT_SITE_BASE_URL;
  const groups = [];
  for (const groupSpec of SCOPE_GROUPS) {
    const docs = await collectGroupDocs(repoRoot, groupSpec, siteBaseUrl);
    groups.push({ id: groupSpec.id, label: groupSpec.label, purpose: groupSpec.purpose, docs });
  }
  const bundles = groups
    .filter((g) => g.docs.length > 0)
    .map((g) => {
      const content = renderBundle(g);
      return {
        id: g.id,
        label: g.label,
        purpose: g.purpose,
        content,
        bytes: Buffer.byteLength(content, 'utf-8'),
      };
    });
  const full = renderFull(groups);
  const index = renderIndex(groups, siteBaseUrl, bundles);
  return { index, full, bundles };
}

export async function writeLlmContext(repoRoot, outDir, opts = {}) {
  const result = await generateLlmContext(repoRoot, opts);
  await assertBundleQuality(repoRoot, result);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'llms.txt'), result.index, 'utf-8');
  await fs.writeFile(path.join(outDir, 'llms-full.txt'), result.full, 'utf-8');
  for (const b of result.bundles) {
    await fs.writeFile(path.join(outDir, `llms-${b.id}.txt`), b.content, 'utf-8');
  }
  return result;
}
