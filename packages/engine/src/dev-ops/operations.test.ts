import { describe, it, expect } from 'vitest';
import { DEVELOPER_OPERATIONS, developerOpsForEntrypoint } from './operations.js';

describe('developer operation registry', () => {
  it('has unique ids', () => {
    const ids = DEVELOPER_OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a tool iff exposed to mcp, and only for mcp-appropriate ops', () => {
    for (const op of DEVELOPER_OPERATIONS) {
      if (op.entrypoints.mcp) {
        expect(op.mcpAppropriate, `${op.id} mcp:true must be mcpAppropriate`).toBe(true);
        expect(op.mcpTool, `${op.id} mcp:true must name a tool`).toBeTruthy();
      } else {
        expect(op.mcpTool, `${op.id} mcp:false must not name a tool`).toBeNull();
      }
    }
  });

  it('never exposes secret-value writes or destructive deletes to mcp', () => {
    const banned = DEVELOPER_OPERATIONS.filter(
      (o) =>
        o.entrypoints.mcp &&
        (o.id === 'secrets.set' || o.id.endsWith('.delete') || o.id.endsWith('.deleteScope')),
    );
    expect(banned).toEqual([]);
  });

  it('every cli/mcp op also has an http route', () => {
    for (const op of DEVELOPER_OPERATIONS) {
      if (op.entrypoints.cli || op.entrypoints.mcp) {
        expect(op.entrypoints.http, `${op.id} needs http`).toBe(true);
      }
    }
  });

  it('tool names are unique across the registry', () => {
    const tools = DEVELOPER_OPERATIONS.map((o) => o.mcpTool).filter((t): t is string => t !== null);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('selects ops by entrypoint', () => {
    expect(developerOpsForEntrypoint('mcp').every((o) => o.entrypoints.mcp)).toBe(true);
    expect(developerOpsForEntrypoint('cli').every((o) => o.entrypoints.cli)).toBe(true);
    expect(developerOpsForEntrypoint('http').every((o) => o.entrypoints.http)).toBe(true);
    expect(developerOpsForEntrypoint('ui').every((o) => o.entrypoints.ui)).toBe(true);
  });
});

describe('repoScoped declaration', () => {
  it('declares repoScoped on every row', () => {
    for (const op of DEVELOPER_OPERATIONS) {
      expect(typeof op.repoScoped, `${op.id} must declare repoScoped`).toBe('boolean');
    }
  });

  it('marks every runs / workflows / held-runs op repo-scoped', () => {
    const scopedDomains = ['runs', 'workflows', 'held-runs'];
    for (const op of DEVELOPER_OPERATIONS) {
      if (scopedDomains.includes(op.domain)) {
        expect(op.repoScoped, `${op.id} acts on a repository's resource`).toBe(true);
      }
    }
  });

  it('never marks a secrets op repo-scoped', () => {
    // Scoped secrets are keyed by context / environment on the customer's
    // orchestrator, so there is no repository to scope against.
    for (const op of DEVELOPER_OPERATIONS) {
      if (op.domain === 'secrets') {
        expect(op.repoScoped, `${op.id} has no repository to scope on`).toBe(false);
      }
    }
  });

  it('covers the registration write ops the HTTP surface exposes', () => {
    const ids = DEVELOPER_OPERATIONS.map((o) => o.id);
    expect(ids).toContain('workflows.disable');
    expect(ids).toContain('workflows.delete');
    for (const id of ['workflows.disable', 'workflows.delete']) {
      const op = DEVELOPER_OPERATIONS.find((o) => o.id === id)!;
      expect(op.entrypoints.http).toBe(true);
      expect(op.entrypoints.mcp).toBe(false);
      expect(op.mcpAppropriate).toBe(false);
      expect(op.repoScoped).toBe(true);
    }
  });
});
