/**
 * Boot-persistence for Firecracker host bridges: install a dependency-free
 * provisioning script + a per-bridge systemd oneshot unit so the bridge is
 * recreated on reboot (the kernel bridge/nft state is non-persistent).
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@kici-dev/shared';
import { renderBootScript, type FirecrackerBridgeConfig } from './host-network.js';

const execFileP = promisify(execFileCb);
const logger = createLogger({ prefix: 'fc-persist' });

export const BOOT_SCRIPT_DIR = '/usr/local/lib/kici-firecracker';
export const SYSTEMD_DIR = '/etc/systemd/system';

export function persistUnitName(bridgeName: string): string {
  return `kici-fc-net-${bridgeName}.service`;
}

export function renderPersistUnit(bridgeName: string): string {
  return [
    '[Unit]',
    `Description=KiCI Firecracker host bridge ${bridgeName}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${BOOT_SCRIPT_DIR}/provision-${bridgeName}.sh`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Install the boot script + unit and `systemctl enable` it (enable only — the
 * deploy/CLI provisions the bridge live in the same run, so the unit fires on
 * the NEXT boot rather than re-churning nft now).
 */
export async function installPersist(
  cfg: FirecrackerBridgeConfig,
  opts: { requireSudo?: boolean } = {},
): Promise<void> {
  const sudo = opts.requireSudo ?? false;
  const run = (bin: string, args: string[]) =>
    sudo
      ? execFileP('sudo', ['-n', bin, ...args], { timeout: 30_000 })
      : execFileP(bin, args, { timeout: 30_000 });

  const scriptPath = `${BOOT_SCRIPT_DIR}/provision-${cfg.bridgeName}.sh`;
  const unitPath = `${SYSTEMD_DIR}/${persistUnitName(cfg.bridgeName)}`;

  await mkdir(BOOT_SCRIPT_DIR, { recursive: true });
  await writeFile(scriptPath, renderBootScript(cfg), 'utf8');
  await chmod(scriptPath, 0o755);
  await writeFile(unitPath, renderPersistUnit(cfg.bridgeName), 'utf8');
  await run('systemctl', ['daemon-reload']);
  await run('systemctl', ['enable', persistUnitName(cfg.bridgeName)]);
  logger.info(`installed + enabled ${persistUnitName(cfg.bridgeName)} (boot script ${scriptPath})`);
}
