/**
 * Structural guard: the trust-policy decision reaching the dispatch gate must
 * come from `evaluateSecurityPolicy`, not from a literal.
 *
 * The behavioral tests cannot see this: `dispatch-matched-workflow.test.ts` sets
 * `ctx.securityDecision` by hand and `evaluate-security-policy.test.ts` calls
 * the evaluator directly, so both stay green if the call site in
 * `process-webhook.ts` becomes a `{ action: 'pass' }` literal — a policy read,
 * logged and never consulted.
 *
 * Argument assertions are scoped to one call block (`callBlock`): a whole-file
 * regex matches identical text at other call sites.
 *
 * Same shape as `src/db/migration-test-targets.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { trustPolicySchema } from '@kici-dev/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'process-webhook.ts'), 'utf8');

/** Strip line and block comments so prose cannot satisfy a structural check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const CODE = stripComments(SOURCE);

// `stripComments` is lexer-free, so a `/*` inside a string or regex literal
// could eat code and weaken every assertion; a size floor catches that.
if (CODE.length < SOURCE.length * 0.5) {
  throw new Error(
    'stripComments removed more than half of process-webhook.ts — check for a false comment start',
  );
}

/**
 * The text of one `name({ ... })` call through its matching close. Argument
 * assertions MUST use this slice: `isForkPR: event.isForkPR ?? false` and
 * `trustResolution: trust.trustResolution` occur at other call sites too.
 */
function callBlock(code: string, opening: string): string {
  const start = code.indexOf(opening);
  if (start === -1) throw new Error(`call site not found: ${opening}`);
  const from = code.indexOf('{', start);
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call site: ${opening}`);
}

/**
 * The text of a top-level function, signature through its closing brace.
 * Not `callBlock`: an object-typed parameter owns the first `{`. Inner braces
 * are indented, so the first `\n}` after the signature ends the function.
 */
function functionBody(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start === -1) throw new Error(`function not found: ${signature}`);
  const end = code.indexOf('\n}', start);
  if (end === -1) throw new Error(`unterminated function: ${signature}`);
  return code.slice(start, end + 2);
}

const EVAL_CALL = callBlock(CODE, 'const securityDecision = await evaluateSecurityPolicy(');
const DISPATCH_CALL = callBlock(CODE, 'return matchDispatchAndRecordOutcome(');

describe('trust-policy gate wiring', () => {
  it('binds securityDecision to an evaluateSecurityPolicy call', () => {
    expect(CODE).toMatch(/const\s+securityDecision\s*=\s*await\s+evaluateSecurityPolicy\s*\(/);
  });

  it('threads that binding into the dispatch call, not a fresh literal', () => {
    // Scoped to the call: the shorthand also appears in helper destructuring.
    expect(DISPATCH_CALL).toMatch(/^\s*securityDecision,\s*$/m);
    expect(DISPATCH_CALL).not.toMatch(/securityDecision:/);
  });

  it('passes the real per-PR signals rather than constants', () => {
    // A hardcoded `false` would silently disable the switch with every test green.
    expect(EVAL_CALL).toMatch(/isForkPR:\s*event\.isForkPR\s*\?\?\s*false/);
    expect(EVAL_CALL).toMatch(/trustResolution:\s*trust\.trustResolution/);
  });

  it('drops an ignored event before the lock-file fetch', () => {
    // `ignore` means no run row, check status or clone token, all created at or
    // after the lock-file fetch, so the drop precedes it in source order.
    const drop = CODE.indexOf("securityDecision.action === 'ignore'");
    const lockFetch = CODE.indexOf('await fetchLockFileWithFallbackPhase(');
    expect(drop).toBeGreaterThan(-1);
    expect(lockFetch).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(lockFetch);
    // …and the evaluation it reads must itself precede the drop.
    const evaluate = CODE.indexOf('const securityDecision = await evaluateSecurityPolicy(');
    expect(evaluate).toBeGreaterThan(-1);
    expect(evaluate).toBeLessThan(drop);
  });

  it('evaluates the policy exactly once per delivery in the per-repo pipeline', () => {
    // Two evaluations would double-count the decision metric and open a TOCTOU
    // window between drop and gate. Counted per call SHAPE: the cross-source
    // path has its own call.
    const perRepo = CODE.match(/const securityDecision = await evaluateSecurityPolicy\(/g) ?? [];
    expect(perRepo).toHaveLength(1);
  });

  it('defaults the orchestrator mode to the fail-closed side', () => {
    // 'independent' would silently open the gate for deps built without a mode.
    expect(EVAL_CALL).toMatch(/mode:\s*deps\.orchestratorMode\s*\?\?\s*'platform'/);
    expect(EVAL_CALL).not.toMatch(/mode:\s*deps\.orchestratorMode\s*\?\?\s*'independent'/);
  });

  it('scopes evaluation to providers with a fork model', () => {
    expect(CODE).toMatch(/if\s*\(!isPREvent\s*\|\|\s*!bundle\.hasForkModel\)/);
  });

  it('gates dispatch on the decision without a disabling conjunct', () => {
    const gateCode = stripComments(
      readFileSync(join(HERE, 'dispatch-matched-workflow.ts'), 'utf8'),
    );
    const gate = functionBody(gateCode, 'async function applyTrustPolicyGate(');

    // The gate bails early only on a resume re-entry; any extra conjunct
    // (`false &&`, a feature flag) would disable enforcement unnoticed.
    expect(gate).toMatch(/if \(opts\.reuseRunId\) return null;/);

    // Exhaustive `switch`, so a `default` arm exists.
    expect(gate).toMatch(
      /const decision = ctx\.securityDecision;\s*switch \(decision\.action\) \{/,
    );

    // THE REGRESSION GUARD. `securityDecision` is required; a falsy check on it
    // means it went optional, so an unthreaded decision fails open.
    expect(gate).not.toMatch(/!\s*decision/);
    expect(gate).not.toMatch(/decision\s*\?\?/);

    // An unrecognised verdict must DENY: the policy columns are plain TEXT, so a
    // newer Platform can emit an unknown verdict, and falling through dispatches
    // untrusted code.
    expect(gate).toMatch(/default: \{[\s\S]*rejectRunForSecurityPolicy\(/);

    // The `ignore` arm must survive a dead-code sweep: `declineIgnoredDispatch`
    // answers it first, so it is unreachable, and with a `default` arm the
    // compiler does not flag its removal. Without it an `ignore` reaching here
    // becomes the visible failed run `default` writes.
    expect(gate).toMatch(/case 'ignore':/);

    // …and dispatch must actually invoke the gate and honour its result.
    expect(gateCode).toMatch(/const gated = await applyTrustPolicyGate\(ctx, setup, opts\);/);
    expect(gateCode).toMatch(/if \(gated\) return gated;/);
  });
});

/**
 * Which pushed policy fields reach a decision site. Fields derive from the wire
 * schema, so one ADDED to `trustPolicySchema` fails here instead of shipping as
 * an inert setting.
 */
describe('policy fields reach the decision sites they claim to', () => {
  const GATE = stripComments(
    readFileSync(join(HERE, '..', 'security', 'trust-policy-gate.ts'), 'utf8'),
  );
  const DISPATCH = stripComments(readFileSync(join(HERE, 'dispatch-matched-workflow.ts'), 'utf8'));

  /** The evaluator body — where a policy field must be READ, not merely copied. */
  const EVALUATOR = functionBody(GATE, 'export function evaluateTrustPolicy(');
  /** Where the hold verdict is built — the only place the window is resolved. */
  const HOLD_FOR_FORK = functionBody(GATE, 'function holdForFork(');

  const FIELDS = Object.keys(trustPolicySchema.shape);

  it('enumerates the wire fields it is guarding', () => {
    // Positive control: an empty enumeration would make every case vacuous.
    expect(FIELDS.length).toBeGreaterThanOrEqual(2);
    expect(FIELDS).toContain('forkPolicy');
    expect(FIELDS).toContain('approvalExpirySeconds');
    // fails-when: the retired hours spelling is declared on the wire again.
    expect(FIELDS).not.toContain('approvalExpiryHours');
    // fails-when: a non-fork arm the gate never read is declared on the wire again.
    expect(FIELDS).not.toContain('unknownContributorPolicy');
    expect(FIELDS).not.toContain('workflowChangePolicy');
  });

  it('routes forkPolicy into the evaluator switch', () => {
    // The switch subject, not a mere mention elsewhere that decides nothing.
    expect(EVALUATOR).toMatch(/switch \(policy\.forkPolicy\) \{/);
  });

  it('routes the expiry window into the hold-expiry calculation', () => {
    // The window rides the hold outcome; dispatch reads the field the gate copied.
    expect(HOLD_FOR_FORK).toMatch(/approvalExpirySeconds:\s*policy\.approvalExpirySeconds/);
    expect(DISPATCH).toMatch(/decision\.approvalExpirySeconds\s*\?\?/);
  });

  it('accounts for every wire field', () => {
    // A new schema field fails here until routed to a decision site.
    const accounted = new Set(['forkPolicy', 'approvalExpirySeconds']);
    expect(FIELDS.filter((f) => !accounted.has(f))).toEqual([]);
  });
});
