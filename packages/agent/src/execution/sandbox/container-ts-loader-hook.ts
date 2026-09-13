// Container-only ESM loader hook: transforms `.ts` / `.tsx` files on import via
// TypeScript's pure-JS `transpileModule` — no native binding — so it loads
// inside an arbitrary customer job container where the native oxc-transform
// hook cannot resolve. Registered via `module.register('file:///opt/kici/ts-loader-hook.js', …)`
// from the containerized workflow runner. bwrap/firecracker keep the oxc hook.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // `inlineSourceMap` embeds the base64 map directly in `outputText`, so
      // stack traces point at the original `.ts` line. It is mutually exclusive
      // with `sourceMap`, so only this one is set.
      inlineSourceMap: true,
      inlineSources: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: false,
      ...(isTsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length) {
    const msg = diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`typescript transpile failed for ${filePath}:\n${msg}`);
  }
  return { format: 'module', source: outputText, shortCircuit: true };
}
