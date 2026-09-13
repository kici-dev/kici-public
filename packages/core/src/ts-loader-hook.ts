// Node ESM loader hook: transforms `.ts` / `.tsx` files on import via
// `oxc-transform`, the Rust-based transformer that backs Rolldown. Registered
// via `module.register('@kici-dev/shared/ts-loader-hook', ...)` from the `kici`
// CLI and the agent's sandbox process — one source of truth so CLI-local
// behavior matches agent-side execution.
//
// Usage:
//   import { register } from 'node:module';
//   register('@kici-dev/shared/ts-loader-hook', import.meta.url);
//
// The `resolve` half rewrites `./foo.js` specifiers to `./foo.ts` when only
// the `.ts` sibling exists on disk (TypeScript-ESM convention with
// `allowImportingTsExtensions`). The `load` half intercepts `.ts` / `.tsx`
// URLs, reads the source, runs `oxc-transform`, and returns JS with an inline
// base64 source map so stack traces point at the original `.ts` line.

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
