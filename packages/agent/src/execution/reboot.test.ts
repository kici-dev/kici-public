import { describe, it, expect } from 'vitest';
import { rebootCommandFor } from './reboot.js';

describe('rebootCommandFor', () => {
  it('selects the right reboot command per OS', () => {
    expect(rebootCommandFor('linux')).toEqual({ cmd: 'systemctl', args: ['reboot'] });
    expect(rebootCommandFor('darwin')).toEqual({ cmd: 'shutdown', args: ['-r', 'now'] });
    expect(rebootCommandFor('win32')).toEqual({ cmd: 'shutdown', args: ['/r', '/t', '0'] });
  });

  it('defaults unknown platforms to the systemctl path', () => {
    expect(rebootCommandFor('freebsd' as NodeJS.Platform)).toEqual({
      cmd: 'systemctl',
      args: ['reboot'],
    });
  });
});
