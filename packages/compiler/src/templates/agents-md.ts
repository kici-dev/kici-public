/**
 * Template body for .kici/AGENTS.md, written by `kici init` (unless opted out
 * via --no-agents-md). The format follows the cross-tool AGENTS.md convention
 * picked up by Claude Code, Cursor, Aider, and other coding agents that scan
 * the working tree for an authoring context file.
 */
export const agentsMdTemplate = `# KiCI workflow authoring guide

This project uses KiCI — a TypeScript-native CI/CD workflow engine — instead
of YAML-based CI. Workflows live in \`.kici/workflows/*.ts\`, are compiled
into a portable lock file, and executed by self-hosted agents.

## Where the API surface lives

- Public SDK types: \`node_modules/@kici-dev/sdk/dist/index.d.ts\` — read this
  for the canonical signatures of \`workflow\`, \`job\`, \`step\`, \`pr\`,
  \`push\`, \`schedule\`, \`matrix\`, \`rule\`, \`dynamicJob\`, etc.
- Bundled offline reference for coding agents: \`kici docs llm\` prints the
  full markdown documentation bundle to stdout. \`kici docs llm --index\`
  prints just the curated link index (llms.txt format).
- Online docs:
  - <https://kici.dev/docs/> — published docs site.
  - <https://kici.dev/llms.txt> — curated index for LLM consumers.
  - <https://kici.dev/llms-full.txt> — full markdown bundle.
  - Key pages: \`user/sdk-reference\`, \`user/workflow-patterns\`,
    \`user/testing-guide\`, \`user/hooks\`, \`user/secrets\`.

## The five core patterns

1. **Push trigger** — \`on: push({ branches: 'main' })\`. Pair with \`paths\`
   to scope to subtrees.

   \`\`\`ts
   import { workflow, job, step, push } from '@kici-dev/sdk';

   export default workflow('build', {
     on: push({ branches: 'main' }),
     jobs: [
       job('build', {
         runsOn: 'kici:os:linux',
         steps: [step('install', async ({ $ }) => { await $\`pnpm install\`; })],
       }),
     ],
   });
   \`\`\`

   \`kici:os:linux\` targets any agent reporting that OS — every agent
   self-reports \`kici:os:\` / \`kici:arch:\` / \`kici:host:\`. Use a custom label
   (e.g. \`'gpu'\`, \`'prod-pool'\`) to target a specific agent pool your scaler
   defines.

2. **PR + matrix** — \`pr({ target: 'main' })\` plus a matrix over node
   versions. The matrix expands at dispatch time.

   \`\`\`ts
   import { workflow, job, step, pr, matrix } from '@kici-dev/sdk';

   export default workflow('test-matrix', {
     on: pr({ target: 'main' }),
     jobs: [
       job('test', {
         runsOn: 'kici:os:linux',
         strategy: { matrix: matrix({ node: ['20', '22', '24'] }) },
         steps: [
           step('test', async ({ $, matrix }) => {
             await $\`node --version\`;
             await $\`pnpm install\`;
             await $\`pnpm test\`;
             return { node: matrix.node };
           }),
         ],
       }),
     ],
   });
   \`\`\`

3. **Lifecycle hooks** — \`onFailure\` / \`onSuccess\` / \`onCancel\` on a
   job or workflow run after the main steps in their own scope.

4. **Secrets** — declared scopes resolve at dispatch:

   \`\`\`ts
   step('deploy', async ({ $, secrets }) => {
     await $\`./scripts/deploy.sh\`.env({ DEPLOY_TOKEN: secrets.production.DEPLOY_TOKEN });
   });
   \`\`\`

   Run \`kici secrets list\` to enumerate the contexts available for testing.

5. **Dynamic jobs** — \`dynamicJob\` and \`dynamicGroup\` build the DAG at
   runtime from a step's outputs. Don't try to compute job names at top level;
   the lock file would be wrong.

## Anti-patterns

- **Do NOT write \`.yml\` / \`.yaml\` CI files** — KiCI replaces that entire
  layer. There is no compatibility shim.
- **Do NOT \`import\` from any \`@kici-dev/*\` package's \`/dist/...\`
  subpath** — those are not part of the public API and break across versions.
  Import from the package root.
- **Do NOT \`await\` outside step bodies.** The top-level workflow file is
  loaded by the compiler synchronously; async I/O at module scope means the
  lock file emits before it resolves and the workflow appears empty.
- **Do NOT mutate shared variables between jobs.** Each job runs in its own
  agent process. Use \`needs\` + step outputs to thread values.
- **Do NOT hand-edit \`kici.lock.json\`.** Regenerate it via \`kici compile\`.

## Local commands a coding agent should run

| Command                         | Purpose                                     |
| ------------------------------- | ------------------------------------------- |
| \`pnpm kici compile --check\`     | Validate workflow source without writing.   |
| \`pnpm kici test pr:open --debug\`| Preview which workflows match an event.     |
| \`pnpm kici run local push\`      | Execute workflows locally with no orchestrator. |
| \`pnpm kici docs llm\`            | Print the full LLM documentation bundle.    |
| \`pnpm kici docs llm --index\`    | Print the curated link index.               |

If \`pnpm kici\` isn't in scripts, fall back to \`npx kici\`.

## Loop

1. Read the SDK types from \`node_modules/@kici-dev/sdk/dist/index.d.ts\`.
2. Pipe \`kici docs llm\` into the agent's context if it doesn't already have
   the full bundle.
3. Edit a workflow under \`.kici/workflows/\`.
4. Run \`kici compile --check\` (zero exit means valid).
5. Run \`kici test <event>\` to preview matching.
6. Run \`kici run local <event>\` to execute locally before pushing.
`;
