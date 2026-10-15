// Node ESM loader hook transforming `.ts` / `.tsx` on import via `oxc-transform`
// (the transformer behind Rolldown). Both the `kici` CLI and the agent's sandbox
// register it, so CLI-local behavior matches agent-side execution:
//   register('@kici-dev/shared/ts-loader-hook', import.meta.url);
//
// `resolve` rewrites `./foo.js` to `./foo.ts` when only the `.ts` sibling
// exists (TypeScript-ESM convention). `load` emits JS with an inline base64
// source map so stack traces point at the original `.ts` line.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'oxc-transform';

type ResolveContext = {
  parentURL?: string;
  conditions: string[];
  importAttributes: Record<string, string>;
};
type ResolveResult = {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
};
type NextResolve = (
  specifier: string,
  context?: ResolveContext,
) => ResolveResult | Promise<ResolveResult>;

type LoadContext = {
  format?: string | null;
  importAttributes: Record<string, string>;
  conditions: string[];
};
type LoadResult = {
  format: string;
  source?: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
};
type NextLoad = (url: string, context?: LoadContext) => LoadResult | Promise<LoadResult>;

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): ResolveResult | Promise<ResolveResult> {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    try {
      if (context.parentURL) {
        const jsUrl = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(jsUrl))) {
          const tsSpecifier = specifier.slice(0, -3) + '.ts';
          const tsUrl = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(tsUrl))) {
            return nextResolve(tsSpecifier, context);
          }
        }
      }
    } catch {
      // Fall through to default resolution.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const bareUrl = url.split('?')[0].split('#')[0];
  const isTs = bareUrl.endsWith('.ts');
  const isTsx = bareUrl.endsWith('.tsx');
  if (!isTs && !isTsx) return nextLoad(url, context);
  const filePath = fileURLToPath(bareUrl);
  const source = await readFile(filePath, 'utf8');
  const result = transformSync(filePath, source, {
    lang: isTsx ? 'tsx' : 'ts',
    sourcemap: true,
    typescript: { allowNamespaces: true },
  });
  if (result.errors.length) {
    const msg = result.errors.map((e) => e.message).join('\n');
    throw new Error(`oxc-transform failed for ${filePath}:\n${msg}`);
  }
  let code = result.code;
  if (result.map) {
    const b64 = Buffer.from(JSON.stringify(result.map)).toString('base64');
    code += `\n//# sourceMappingURL=data:application/json;base64,${b64}\n`;
  }
  return { format: 'module', source: code, shortCircuit: true };
}
