/**
 * Format an ISO timestamp as a relative time string (e.g. "2 minutes ago").
 */
export function formatRelativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return 'just now';

  const minutes = Math.floor(ms / (60 * 1000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
