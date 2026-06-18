import { describe, it, expect } from 'vitest';
import { analyzePurity } from './purity-analyzer.js';

describe('purity-analyzer', () => {
  describe('pure functions', () => {
    it('identifies simple property access as pure', () => {
      const result = analyzePurity('(event) => event.ref');
      expect(result.pure).toBe(true);
    });

    it('identifies chained method calls as pure', () => {
      const result = analyzePurity('(event) => event.ref.split("/").pop()');
      expect(result.pure).toBe(true);
    });

    it('identifies destructured parameters as pure', () => {
      const result = analyzePurity('({ ref }) => ref.split("/").pop()');
      expect(result.pure).toBe(true);
    });

    it('identifies template literals as pure', () => {
      const result = analyzePurity('(event) => `deploy-${event.environment}`');
      expect(result.pure).toBe(true);
    });

    it('identifies object return as pure', () => {
      const result = analyzePurity('(event) => ({ NODE_ENV: event.env })');
      expect(result.pure).toBe(true);
    });

    it('identifies ternary as pure', () => {
      const result = analyzePurity('(event) => event.action === "opened" ? "staging" : "prod"');
      expect(result.pure).toBe(true);
    });

    it('identifies local const declaration as pure', () => {
      const result = analyzePurity('(event) => { const branch = event.ref; return branch; }');
      expect(result.pure).toBe(true);
    });

    it('identifies JSON as safe global', () => {
      const result = analyzePurity('(event) => JSON.stringify(event)');
      expect(result.pure).toBe(true);
    });

    it('identifies String as safe global', () => {
      const result = analyzePurity('(event) => String(event.ref)');
      expect(result.pure).toBe(true);
    });

    it('identifies Math as safe global', () => {
      const result = analyzePurity('(event) => Math.max(1, 2)');
      expect(result.pure).toBe(true);
    });
  });

  describe('impure functions', () => {
    it('rejects async functions', () => {
      const result = analyzePurity('async (event) => event.ref');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('async');
    });

    it('rejects require calls', () => {
      const result = analyzePurity('(event) => require("fs").readFileSync("/etc")');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('require');
    });

    it('rejects unknown global identifiers like fetch', () => {
      const result = analyzePurity('(event) => fetch(event.url)');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('fetch');
    });

    it('rejects process access', () => {
      const result = analyzePurity('(event) => process.env.FOO');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('process');
    });

    it('rejects dynamic import', () => {
      const result = analyzePurity('(event) => { import("fs"); return event.ref; }');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('import');
    });

    it('rejects new expressions', () => {
      const result = analyzePurity('(event) => new Date()');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('new');
    });

    it('rejects throw statements', () => {
      const result = analyzePurity('(event) => { throw new Error("x"); }');
      expect(result.pure).toBe(false);
    });

    it('rejects mutation via postfix ++', () => {
      const result = analyzePurity('(event) => { let x = 1; x++; return x; }');
      expect(result.pure).toBe(false);
    });

    it('rejects var declarations', () => {
      const result = analyzePurity('(event) => { var x = 1; return x; }');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('var');
    });

    it('rejects assignment operators', () => {
      const result = analyzePurity('(event) => { let x = 1; x += 2; return x; }');
      expect(result.pure).toBe(false);
    });

    it('rejects this keyword', () => {
      const result = analyzePurity('(event) => this.value');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('this');
    });

    it('rejects yield expressions', () => {
      // Generator function body - we test the expression detection
      const result = analyzePurity('function* (event) { yield event.ref; }');
      expect(result.pure).toBe(false);
    });

    it('rejects delete expressions', () => {
      const result = analyzePurity('(event) => { delete event.ref; return event; }');
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('delete');
    });

    it('rejects try/catch', () => {
      const result = analyzePurity(
        '(event) => { try { return event.ref; } catch(e) { return ""; } }',
      );
      expect(result.pure).toBe(false);
      expect(result.reason).toContain('try');
    });
  });

  describe('edge cases', () => {
    it('handles multiple parameters', () => {
      const result = analyzePurity('(event, context) => event.ref + context.id');
      expect(result.pure).toBe(true);
    });

    it('handles array destructuring in params', () => {
      const result = analyzePurity('([first, second]) => first + second');
      expect(result.pure).toBe(true);
    });

    it('handles nested property access', () => {
      const result = analyzePurity('(event) => event.payload.pull_request.head.ref');
      expect(result.pure).toBe(true);
    });

    it('handles shorthand property in object literal', () => {
      const result = analyzePurity('(event) => { const ref = event.ref; return { ref }; }');
      expect(result.pure).toBe(true);
    });

    it('handles let declarations as local', () => {
      const result = analyzePurity('(event) => { let branch = event.ref; return branch; }');
      expect(result.pure).toBe(true);
    });

    it('handles parseInt as safe global', () => {
      const result = analyzePurity('(event) => parseInt(event.count, 10)');
      expect(result.pure).toBe(true);
    });

    it('handles encodeURIComponent as safe global', () => {
      const result = analyzePurity('(event) => encodeURIComponent(event.name)');
      expect(result.pure).toBe(true);
    });

    it('handles spread operator', () => {
      const result = analyzePurity('(event) => ({ ...event, extra: "value" })');
      expect(result.pure).toBe(true);
    });

    it('handles array literal with map', () => {
      const result = analyzePurity('(event) => [event.a, event.b].join("-")');
      expect(result.pure).toBe(true);
    });
  });
});
