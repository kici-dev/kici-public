import { describe, it, expect } from 'vitest';
import { renderPersistUnit, BOOT_SCRIPT_DIR, persistUnitName } from './persist.js';

describe('renderPersistUnit', () => {
  it('is a network-online oneshot that runs the per-bridge boot script', () => {
    const unit = renderPersistUnit('kici-br0');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Wants=network-online.target');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain(`ExecStart=${BOOT_SCRIPT_DIR}/provision-kici-br0.sh`);
  });

  it('names the unit per bridge', () => {
    expect(persistUnitName('kici-br1')).toBe('kici-fc-net-kici-br1.service');
  });
});
