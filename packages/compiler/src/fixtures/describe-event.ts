/**
 * Describe the event type from a fixture's trigger config, for the fixtures
 * table and the interactive picker.
 */
export function describeEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return 'unknown';
  const e = event as Record<string, unknown>;
  if (e._type === 'push') return 'push';
  if (e._type === 'pr') return `pr:${(e as Record<string, unknown>).action ?? 'open'}`;
  if (typeof e._type === 'string') return String(e._type);
  return 'custom';
}
