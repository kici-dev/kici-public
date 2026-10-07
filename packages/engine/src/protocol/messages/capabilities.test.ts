import { describe, expect, it } from 'vitest';
import {
  orchCapabilitiesSchema,
  OrchRole,
  ORCH_CAPABILITIES,
  platformCapabilitiesSchema,
  PLATFORM_CAPABILITIES,
  orchAgentCapabilitiesSchema,
  ORCH_AGENT_CAPABILITIES,
  agentCapabilitiesSchema,
  AGENT_CAPABILITIES,
} from './capabilities.js';
import { agentRegisterSchema } from './orchestrator-agent.js';

describe('OrchRole', () => {
  it('has coordinator and worker values', () => {
    expect(OrchRole.enum.coordinator).toBe('coordinator');
    expect(OrchRole.enum.worker).toBe('worker');
  });

  it('parses valid values', () => {
    expect(OrchRole.parse('coordinator')).toBe('coordinator');
    expect(OrchRole.parse('worker')).toBe('worker');
  });

  it('rejects invalid values', () => {
    expect(() => OrchRole.parse('invalid')).toThrow();
    expect(() => OrchRole.parse('')).toThrow();
  });
});

describe('orchCapabilitiesSchema', () => {
  it('refuses an object without orchRole', () => {
    // fails-when: orchRole stays optional.
    expect(orchCapabilitiesSchema.safeParse({}).success).toBe(false);
  });

  it('accepts full capabilities object', () => {
    const caps = { orchRole: 'coordinator' };
    const result = orchCapabilitiesSchema.parse(caps);
    expect(result).toEqual(caps);
  });

  it('accepts worker role', () => {
    const result = orchCapabilitiesSchema.parse({ orchRole: 'worker' });
    expect(result.orchRole).toBe('worker');
  });

  it('rejects invalid orchRole', () => {
    expect(() => orchCapabilitiesSchema.parse({ orchRole: 'invalid' })).toThrow();
  });

  it('preserves unknown flags via passthrough', () => {
    const result = orchCapabilitiesSchema.parse({
      orchRole: 'coordinator',
      futureFlag: true,
      anotherFlag: 42,
    });
    expect(result).toEqual({ orchRole: 'coordinator', futureFlag: true, anotherFlag: 42 });
  });
});

describe('ORCH_CAPABILITIES', () => {
  it('has orchRole set to coordinator', () => {
    expect(ORCH_CAPABILITIES.orchRole).toBe('coordinator');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ORCH_CAPABILITIES)).toBe(true);
  });
});

describe('orchCapabilitiesSchema without negotiation flags', () => {
  // fails-when: the removed dashboard-request manifest or join flag is advertised again.
  it('advertises only the role', () => {
    expect(ORCH_CAPABILITIES).toEqual({ orchRole: 'coordinator' });
  });
});

describe.each([
  ['platformCapabilitiesSchema', platformCapabilitiesSchema, PLATFORM_CAPABILITIES],
  ['orchAgentCapabilitiesSchema', orchAgentCapabilitiesSchema, ORCH_AGENT_CAPABILITIES],
  ['agentCapabilitiesSchema', agentCapabilitiesSchema, AGENT_CAPABILITIES],
] as const)('%s', (_name, schema, defaults) => {
  // fails-when: a removed flag (orchMetrics, artifactCompleteAck,
  // globalEvalSkipsResultAwareGenerators) is advertised again.
  it('advertises an empty, frozen set that parses through its own schema', () => {
    expect(defaults).toEqual({});
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(schema.parse(defaults)).toEqual({});
  });

  // breaks-if-wrong: a newer peer's flag must survive parsing, not be stripped.
  it('preserves unknown flags via passthrough', () => {
    expect(schema.parse({ futureFlag: true })).toEqual({ futureFlag: true });
  });
});

describe('agent.register capabilities', () => {
  it('parses with and without the field', () => {
    const base = { type: 'agent.register', messageId: 'm', agentId: 'a', labels: [] };
    expect(agentRegisterSchema.parse(base).capabilities).toBeUndefined();
    expect(
      agentRegisterSchema.parse({ ...base, capabilities: AGENT_CAPABILITIES }).capabilities,
    ).toEqual({});
  });
});
