import { describe, expect, it } from 'vitest';

import { parseExtraHost, renderGuestExtraHosts } from './firecracker-extra-hosts.js';

describe('parseExtraHost', () => {
  it.each([
    ['registry.local:10.0.0.1', { host: 'registry.local', address: '10.0.0.1' }],
    [
      'npm-cache.example.internal:host-gateway',
      { host: 'npm-cache.example.internal', address: 'host-gateway' },
    ],
    ['cache:fd00::1', { host: 'cache', address: 'fd00::1' }],
    ['Registry.Local:192.168.10.4', { host: 'Registry.Local', address: '192.168.10.4' }],
  ])('parses %s', (entry, expected) => {
    // breaks-if-wrong: the shapes the container backend accepts for the same
    // field — a dotted name, the host-gateway keyword, an IPv6 address — parse.
    expect(parseExtraHost(entry)).toEqual(expected);
  });

  it.each([
    ['registry.local', /host:address/],
    ['registry.local:', /host:address/],
    [':10.0.0.1', /host:address/],
    ['registry.local:not-an-ip', /IP address or host-gateway/],
    ['registry.local:10.0.0.1 evil.example', /IP address or host-gateway/],
    ['bad host:10.0.0.1', /hostname/],
    ['-lead.example:10.0.0.1', /hostname/],
    ['a,b:10.0.0.1', /hostname/],
    ['registry.local\n10.0.0.2 other:10.0.0.1', /hostname/],
  ])('refuses %j', (entry, reason) => {
    // fails-when: an entry that could write a second line, a second name or a
    // non-address into the guest's /etc/hosts gets through.
    expect(() => parseExtraHost(entry)).toThrow(reason);
  });
});

describe('renderGuestExtraHosts', () => {
  it('renders nothing when the scaler configures no mappings', () => {
    // fails-when: the backend writes a mapping into MMDS for a scaler that
    // asked for none.
    expect(renderGuestExtraHosts(undefined, '10.0.0.1')).toBeUndefined();
    expect(renderGuestExtraHosts([], '10.0.0.1')).toBeUndefined();
  });

  it('resolves host-gateway to the bridge gateway and keeps literal addresses', () => {
    expect(
      renderGuestExtraHosts(
        ['registry.local:host-gateway', 'cache.example.internal:10.1.2.3', 'v6:fd00::1'],
        '10.0.0.1',
      ),
    ).toBe('registry.local:10.0.0.1,cache.example.internal:10.1.2.3,v6:fd00::1');
  });

  it('refuses to resolve host-gateway to a gateway that is not an address', () => {
    // fails-when: a malformed `firecracker.gateway` reaches the guest's
    // /etc/hosts through the keyword, where it could add a second name.
    expect(() => renderGuestExtraHosts(['registry.local:host-gateway'], '10.0.0.1 evil')).toThrow(
      /gateway/,
    );
    // breaks-if-wrong: a literal address never needs the gateway at all.
    expect(renderGuestExtraHosts(['registry.local:10.1.2.3'], 'not-an-ip')).toBe(
      'registry.local:10.1.2.3',
    );
  });

  it('refuses a malformed entry rather than passing it to the guest', () => {
    expect(() => renderGuestExtraHosts(['registry.local'], '10.0.0.1')).toThrow(/host:address/);
  });
});
