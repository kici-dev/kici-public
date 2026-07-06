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
