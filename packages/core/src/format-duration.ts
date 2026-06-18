/**
 * Format seconds into human-readable uptime.
 * Examples: "45s", "3m 12s", "2h 15m", "1d 3h 12m"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ${mins}m`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "0s", "0.3s", "12.3s", "1m 23s", "1h 2m 3s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
