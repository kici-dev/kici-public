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
    // here would silently disable an arm while leaving every test green — which
    // is exactly what a whole-file regex failed to catch.
    expect(EVAL_CALL).toMatch(/isForkPR:\s*event\.isForkPR\s*\?\?\s*false/);
    expect(EVAL_CALL).toMatch(/hasWorkflowModifications:\s*security\.hasWorkflowModifications/);
    expect(EVAL_CALL).toMatch(/trustResolution:\s*trust\.trustResolution/);
  });

  it('defaults the orchestrator mode to the fail-closed side', () => {
    // `deps.orchestratorMode ?? 'platform'` — defaulting to 'independent'
    // would silently open the gate for any deps object built without a mode.
    expect(EVAL_CALL).toMatch(/mode:\s*deps\.orchestratorMode\s*\?\?\s*'platform'/);
    expect(EVAL_CALL).not.toMatch(/mode:\s*deps\.orchestratorMode\s*\?\?\s*'independent'/);
  });

  it('scopes evaluation to providers with a contributor model', () => {
    expect(CODE).toMatch(/if\s*\(!isPREvent\s*\|\|\s*!bundle\.contributorResolver\)/);
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

    // …and dispatch must actually invoke the gate and honour its result.
    expect(gateCode).toMatch(/const gated = await applyTrustPolicyGate\(ctx, setup, opts\);/);
    expect(gateCode).toMatch(/if \(gated\) return gated;/);
  });
});

/**
 * The wish's criterion 5: the failure mode was not a wrong branch, it was a
 * WHOLE pushed object ignored for as long as it had existed. So the field list
 * is derived from the wire schema rather than written out here — adding a field
 * to `trustPolicySchema` without routing it to a decision site fails this guard
 * instead of shipping one more inert setting.
 */
describe('every pushed policy field reaches a decision site', () => {
  const GATE = stripComments(
    readFileSync(join(HERE, '..', 'security', 'trust-policy-gate.ts'), 'utf8'),
  );
  const DISPATCH = stripComments(readFileSync(join(HERE, 'dispatch-matched-workflow.ts'), 'utf8'));

  /** The evaluator body — where a policy field must be READ, not merely copied. */
  const EVALUATOR = functionBody(GATE, 'export function evaluateTrustPolicy(');

  const FIELDS = Object.keys(trustPolicySchema.shape);

  it('enumerates the wire fields it is guarding', () => {
    // Positive control: if the schema import ever resolves to something without
    // a shape, every per-field case below would vacuously pass over an empty
    // list. Pin the count so a silently-empty enumeration fails loudly.
    expect(FIELDS.length).toBeGreaterThanOrEqual(4);
    expect(FIELDS).toContain('forkPolicy');
    expect(FIELDS).toContain('approvalExpiryHours');
  });

  /**
   * Where each field has to show up to count as routed.
   *
   * The three verdict fields must appear as an ARM's `verdict:`, not merely
   * somewhere in the evaluator. A plain `policy.forkPolicy` check was too weak
   * to falsify: replacing the fork arm's verdict with a literal left the field
   * still referenced by the `forkAllowsThisEvent` guard a few lines up, so the
   * assertion stayed green over a policy value that no longer decided anything.
   *
   * `approvalExpiryHours` is not an arm — it sizes the hold, so it rides the
   * hold outcome into the expiry calculation instead.
   */
  function expectationFor(field: string): { source: string; pattern: RegExp } {
    if (field === 'approvalExpiryHours') {
      return { source: DISPATCH, pattern: /decision\.approvalExpiryHours\s*\?\?/ };
    }
    return { source: EVALUATOR, pattern: new RegExp(`verdict:\\s*policy\\.${field}\\b`) };
  }

  it.each(FIELDS)('routes %s to a decision', (field) => {
    const { source, pattern } = expectationFor(field);
    expect(source).toMatch(pattern);
  });
});
