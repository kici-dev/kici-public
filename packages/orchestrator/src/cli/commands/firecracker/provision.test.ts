import { describe, it, expect } from 'vitest';
import { optionsToConfig } from './provision.js';

describe('optionsToConfig', () => {
  it('maps CLI options to a FirecrackerBridgeConfig with default table', () => {
    expect(optionsToConfig({ bridge: 'kici-br0', cidr: '10.0.0.1/24' })).toEqual({
      bridgeName: 'kici-br0',
      bridgeCidr: '10.0.0.1/24',
      table: 'kici',
      hostIface: undefined,
    });
  });

  it('honors --table and --host-iface', () => {
    expect(
      optionsToConfig({
        bridge: 'kici-br1',
        cidr: '10.0.1.1/24',
        table: 'kici_b',
        hostIface: 'eth0',
      }),
    ).toEqual({
      bridgeName: 'kici-br1',
      bridgeCidr: '10.0.1.1/24',
      table: 'kici_b',
      hostIface: 'eth0',
    });
  });

  it('throws when required options are missing', () => {
    expect(() => optionsToConfig({ bridge: 'kici-br0' } as never)).toThrow(/--cidr/);
  });
});
