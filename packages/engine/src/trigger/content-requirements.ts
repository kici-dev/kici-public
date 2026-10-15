/**
 * Declarative static content-filter matcher.
 *
 * A git-event trigger may carry a `requires` list ({@link LockContentRequirement}):
 * pure DATA describing a query over the bytes of one source file at the event's
 * ref. The orchestrator interprets it here and never executes author code, which
 * keeps content filtering inside the orchestrator under the execution-purity
 * model.
 *
 * It imports `yaml`, so it is the Node-only subpath export
 * `@kici-dev/engine/trigger/content-requirements`, kept out of the browser-facing
 * engine barrel.
 */
import { JSONPath } from 'jsonpath-plus';
import { parse as parseYaml } from 'yaml';
import { matchJsonPath, matchJsonPathNot } from './jsonpath-matcher.js';
import { evaluateTextMatch } from './text-match.js';
import type { LockContentRequirement } from './types.js';
import { resolveContentFormat } from './types.js';

export type { ContentFormat, ContentRequirement, LockContentRequirement } from './types.js';

/** Hard byte cap enforced before any parse: an oversize file is indeterminate. */
const MAX_CONTENT_BYTES = 1024 * 1024; // 1 MiB

/**
 * YAML anchor/alias expansion cap. The `yaml` default of 100 lets a small
 * billion-laughs bomb through; 50 rejects it and still fits anchored configs
 * (merge keys, shared defaults). The 1 MiB byte cap bounds total node count.
 */
const YAML_MAX_ALIAS_COUNT = 50;

/** Result of evaluating a `requires` list: a definite verdict, or fail-visible indeterminate. */
export interface ContentRequirementResult {
  readonly pass: boolean;
  /** Set (with `pass:false`) when a file could not be evaluated — never a silent pass. */
  readonly indeterminate?: string;
}

/**
 * Parse `bytes` for the given format (`yaml` with the alias cap; `text` as the
 * raw string). Throws on a malformed document, which the caller treats as
 * indeterminate.
 */
export function parseForFormat(bytes: string, format: 'json' | 'yaml' | 'text'): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(bytes);
    case 'yaml':
      return parseYaml(bytes, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
    case 'text':
      return bytes;
  }
}

function pathExists(doc: unknown, path: string): boolean {
  const results = JSONPath({ path, json: doc as never, wrap: true }) as unknown[];
  return results.length > 0;
}

/** JSONPath queries need an object root; a non-object parsed doc becomes `{}`. */
function asJsonRoot(doc: unknown): Record<string, unknown> {
  return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {};
}

/**
 * `pass:false` with no `indeterminate` is a definite negative; `indeterminate`
 * means the file could not be evaluated (oversize, parse failure, unsafe regex).
 */
function evaluateOne(
  req: LockContentRequirement,
  entry: { present: boolean; bytes?: string } | undefined,
): ContentRequirementResult {
  const present = entry?.present === true;

  // `absent` is mutually exclusive with query keys: it passes iff the file is missing.
  if (req.absent) return { pass: !present };

  // A query over a missing file is a definite no, not an error.
  if (!present) return { pass: false };

  const bytes = entry?.bytes ?? '';
  if (Buffer.byteLength(bytes, 'utf8') > MAX_CONTENT_BYTES) {
    return { pass: false, indeterminate: `${req.file}: exceeds 1 MiB size cap` };
  }

  // The raw-text keys ignore parse format; the shared matcher keeps this site and
  // the Tier-0 `commitMessage` filter in agreement.
  const textResult = evaluateTextMatch(bytes, {
    ...(req.contains !== undefined && { contains: req.contains }),
    ...(req.notContains !== undefined && { notContains: req.notContains }),
    ...(req.matches !== undefined && { matches: req.matches }),
    ...(req.notMatches !== undefined && { notMatches: req.notMatches }),
    ...(req.ignoreCase !== undefined && { ignoreCase: req.ignoreCase }),
  });
  if (textResult.indeterminate) {
    return { pass: false, indeterminate: `${req.file}: ${textResult.indeterminate}` };
  }
  if (!textResult.pass) return { pass: false };

  const needsParse =
    (req.exists && req.exists.length > 0) ||
    (req.match && Object.keys(req.match).length > 0) ||
    (req.not && Object.keys(req.not).length > 0);

  if (needsParse) {
    const format = resolveContentFormat(req.file, req.format);
    let parsed: unknown;
    try {
      parsed = parseForFormat(bytes, format);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { pass: false, indeterminate: `${req.file}: failed to parse as ${format}: ${reason}` };
    }
    const root = asJsonRoot(parsed);

    if (req.exists) {
      for (const path of req.exists) {
        if (!pathExists(parsed, path)) return { pass: false };
      }
    }
    if (req.match && !matchJsonPath(root, req.match)) return { pass: false };
    if (req.not && !matchJsonPathNot(root, req.not)) return { pass: false };
  }

  return { pass: true };
}

/**
 * Evaluate an AND-ed list of content requirements against a resolved file map.
 *
 * An empty list passes. The first indeterminate entry short-circuits and is
 * surfaced: an unevaluable file NEVER passes silently.
 *
 * @param files Resolved file contents keyed by repo-relative path. A missing key
 *              or `{ present: false }` means the file does not exist at the ref.
 */
export function evaluateContentRequirements(
  reqs: readonly LockContentRequirement[],
  files: Map<string, { present: boolean; bytes?: string }>,
): ContentRequirementResult {
  for (const req of reqs) {
    const result = evaluateOne(req, files.get(req.file));
    if (result.indeterminate) return result;
    if (!result.pass) return { pass: false };
  }
  return { pass: true };
}
