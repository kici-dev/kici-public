/**
 * Structural guard: the trust-policy decision reaching the dispatch gate must
 * come from `evaluateSecurityPolicy`, not from a literal.
 *
 * The behavioral tests structurally cannot see this failure:
 * `dispatch-matched-workflow.test.ts` sets `ctx.securityDecision` by hand and
 * `evaluate-security-policy.test.ts` calls the evaluator directly, so both stay
 * green when the single call site in `process-webhook.ts` is replaced by a
 * `{ action: 'pass' }` literal — a policy that is read, logged, and then not
 * consulted, which is the defect this feature exists to remove.
 *
 * Assertions about call arguments are scoped to the specific call block (see
 * `callBlock`), because a whole-file regex matches identical argument text at
 * other call sites and therefore proves nothing about this one.
 *
 * Same shape as `src/db/migration-test-targets.test.ts`, which asserts over
 * migration-test source text that every per-migration test calls
 * `migrateToOwnMigration` rather than `migrateToLatest`.
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
// could eat arbitrary code and silently weaken every assertion below. A gross
// size floor catches that without a real parser.
if (CODE.length < SOURCE.length * 0.5) {
  throw new Error(
    'stripComments removed more than half of process-webhook.ts — check for a false comment start',
  );
}

/**
 * The text of a single `name({ ... })` call, from the call to its matching
 * close. Assertions about the arguments MUST run against this slice, not the
 * whole file: `isForkPR: event.isForkPR ?? false` and
 * `trustResolution: trust.trustResolution` each occur at other call sites, so a
 * whole-file regex stays green even when the real call site is neutered.
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
 *
 * `callBlock` cannot be reused for this: a signature whose parameters contain
 * an object type (`opts: { reuseRunId?: string | false }`) makes its first `{`
 * the parameter's, so brace matching would return the parameter type instead of
 * the body. Every brace inside a top-level function is indented, so the first
 * `\n}` after the signature is the function's own terminator.
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
    // Scoped to the dispatch call itself: the shorthand also appears in the
    // parameter destructuring of two helper functions.
    expect(DISPATCH_CALL).toMatch(/^\s*securityDecision,\s*$/m);
    expect(DISPATCH_CALL).not.toMatch(/securityDecision:/);
  });

  it('passes the real per-PR signals rather than constants', () => {
    // Each signal must come from the pipeline's own state. A hardcoded `false`
    // here would silently disable the switch while leaving every test green —
    // which is exactly what a whole-file regex failed to catch.
    expect(EVAL_CALL).toMatch(/isForkPR:\s*event\.isForkPR\s*\?\?\s*false/);
    expect(EVAL_CALL).toMatch(/trustResolution:\s*trust\.trustResolution/);
  });

  it('drops an ignored event before the lock-file fetch', () => {
    // The whole point of `ignore`: no run row, no check status, no clone token.
    // Every one of those is created at or after the lock-file fetch, so the
    // drop has to precede that call in source order.
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
    // Two evaluations of the same signals would double-count the decision
    // metric and open a TOCTOU window between the drop and the dispatch gate.
    // The cross-source path has its own call against a registration's bundle,
    // so the count here is per call SHAPE, not a whole-file total.
    const perRepo = CODE.match(/const securityDecision = await evaluateSecurityPolicy\(/g) ?? [];
    expect(perRepo).toHaveLength(1);
  });

  it('defaults the orchestrator mode to the fail-closed side', () => {
    // `deps.orchestratorMode ?? 'platform'` — defaulting to 'independent'
    // would silently open the gate for any deps object built without a mode.
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

    // The gate must bail early on exactly one thing — a resume re-entry. Any
    // extra conjunct (`false &&`, a feature flag) would disable enforcement
    // while every behavioral test still passes.
    expect(gate).toMatch(/if \(opts\.reuseRunId\) return null;/);

    // The verdict is dispatched on exhaustively. A `switch` (rather than a
    // chain of ifs) is what lets the `default` arm exist at all.
    expect(gate).toMatch(
      /const decision = ctx\.securityDecision;\s*switch \(decision\.action\) \{/,
    );

    // THE REGRESSION GUARD. `securityDecision` is required, so a falsy check on
    // it can only be reintroduced by someone making it optional again — which
    // is precisely the fail-open-by-omission this feature removed: forgetting
    // to thread a decision meant the run passed the security gate.
    expect(gate).not.toMatch(/!\s*decision/);
    expect(gate).not.toMatch(/decision\s*\?\?/);

    // An unrecognised verdict must DENY, not fall through. The policy columns
    // are plain TEXT, so a newer Platform can emit a verdict this build has
    // never seen; reaching the end of the switch without acting would dispatch
    // untrusted code.
    expect(gate).toMatch(/default: \{[\s\S]*rejectRunForSecurityPolicy\(/);

    // The `ignore` arm must survive a dead-code sweep. `declineIgnoredDispatch`
    // answers that verdict before the gate is reached, so this arm is
    // unreachable from the dispatch path — and because a `default` arm exists,
    // the compiler does NOT flag its removal. Deleting it would therefore turn
    // an `ignore` that ever reached here into the visible failed run that
    // `default` writes, the exact artifact `ignore` exists to withhold, with no
    // test objecting.
    expect(gate).toMatch(/case 'ignore':/);

    // …and dispatch must actually invoke the gate and honour its result.
    expect(gateCode).toMatch(/const gated = await applyTrustPolicyGate\(ctx, setup, opts\);/);
    expect(gateCode).toMatch(/if \(gated\) return gated;/);
  });
});

/**
 * Which pushed policy fields reach a decision site, and which deliberately do
 * not. The field list is derived from the wire schema rather than written out
 * here, so a field ADDED to `trustPolicySchema` lands in neither bucket and
 * fails loudly instead of shipping as one more inert setting.
 *
 * The two deprecated fields are the deliberate no-ops. Their JSDoc on the wire
 * schema claims they are "accepted for wire compatibility; not enforced", and
 * this is what holds that claim to the source: an arm reintroduced for either
 * of them would make the claim false and fail here.
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
  /** Read by no decision site; carried only because the wire schema declares them. */
  const INERT_FIELDS = ['unknownContributorPolicy', 'workflowChangePolicy'];

  it('enumerates the wire fields it is guarding', () => {
    // Positive control: if the schema import ever resolves to something without
    // a shape, every per-field case below would vacuously pass over an empty
    // list. Pin the membership so a silently-empty enumeration fails loudly.
    expect(FIELDS.length).toBeGreaterThanOrEqual(5);
    expect(FIELDS).toContain('forkPolicy');
    expect(FIELDS).toContain('approvalExpiryHours');
    expect(FIELDS).toContain('approvalExpirySeconds');
    for (const inert of INERT_FIELDS) expect(FIELDS).toContain(inert);
  });

  it('routes forkPolicy into the evaluator switch', () => {
    // The switch subject specifically, not merely a mention: a `switch` over a
    // literal would leave `policy.forkPolicy` referenced elsewhere in the
    // function while deciding nothing.
    expect(EVALUATOR).toMatch(/switch \(policy\.forkPolicy\) \{/);
  });

  it('routes both expiry spellings into the hold-expiry calculation', () => {
    // Neither is an arm — together they name one window, so the pair rides the
    // hold outcome into the expiry calculation instead.
    //
    // The gate resolves the two through `approvalExpirySecondsOf`, which is what
    // makes an hours-only policy still size a hold; dispatch then reads the one
    // resolved field. Asserting only the dispatch half would pass on a build
    // whose gate had dropped the hours fallback, which is the layer the value
    // actually comes from.
    expect(HOLD_FOR_FORK).toMatch(/approvalExpirySeconds:\s*approvalExpirySecondsOf\(policy\)/);
    expect(DISPATCH).toMatch(/decision\.approvalExpirySeconds\s*\?\?/);
  });

  it.each(INERT_FIELDS)('does not route %s to any decision', (field) => {
    expect(EVALUATOR).not.toMatch(new RegExp(`policy\\.${field}\\b`));
  });

  it('accounts for every wire field', () => {
    // A field added to the schema is neither the fork switch, nor the expiry,
    // nor a known inert one — so it fails here until someone routes it or
    // records it as deliberately inert.
    const accounted = new Set([
      'forkPolicy',
      'approvalExpiryHours',
      'approvalExpirySeconds',
      ...INERT_FIELDS,
    ]);
    expect(FIELDS.filter((f) => !accounted.has(f))).toEqual([]);
  });
});
