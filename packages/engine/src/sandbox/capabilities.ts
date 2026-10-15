// The Linux capability set (capabilities(7)) in the bare uppercase Docker
// HostConfig.CapAdd form (no CAP_ prefix), for the SDK validator, the compiler
// and the dispatch resolver. Pure data, so browser-safe.
//
// CAP_CHOWN=0 through CAP_CHECKPOINT_RESTORE=40, the last addition (Linux 5.9+).
export const KNOWN_LINUX_CAPABILITIES: ReadonlySet<string> = new Set([
  'CHOWN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETGID',
  'SETUID',
  'SETPCAP',
  'LINUX_IMMUTABLE',
  'NET_BIND_SERVICE',
  'NET_BROADCAST',
  'NET_ADMIN',
  'NET_RAW',
  'IPC_LOCK',
  'IPC_OWNER',
  'SYS_MODULE',
  'SYS_RAWIO',
  'SYS_CHROOT',
  'SYS_PTRACE',
  'SYS_PACCT',
  'SYS_ADMIN',
  'SYS_BOOT',
  'SYS_NICE',
  'SYS_RESOURCE',
  'SYS_TIME',
  'SYS_TTY_CONFIG',
  'MKNOD',
  'LEASE',
  'AUDIT_WRITE',
  'AUDIT_CONTROL',
  'SETFCAP',
  'MAC_OVERRIDE',
  'MAC_ADMIN',
  'SYSLOG',
  'WAKE_ALARM',
  'BLOCK_SUSPEND',
  'AUDIT_READ',
  'PERFMON',
  'BPF',
  'CHECKPOINT_RESTORE',
]);

/** Normalize a capability name to the bare uppercase form used by CapAdd and the allow-list. */
export function canonicalizeCapability(raw: string): string {
  return raw.trim().toUpperCase().replace(/^CAP_/, '');
}

/** True when `raw` (in either CAP_-prefixed or bare form) is a real Linux capability. */
export function isKnownCapability(raw: string): boolean {
  return KNOWN_LINUX_CAPABILITIES.has(canonicalizeCapability(raw));
}
