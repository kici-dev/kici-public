/**
 * Single-variable env-file upsert. Unlike {@link ./deploy-env.js}, which
 * re-appends a whole `KICI_DEPLOY_*` block, it replaces a hand-settable
 * variable in place, so the comment above still describes the value below.
 */

/** Matches an uncommented `NAME=` assignment, the same shape startup reads. */
function assignmentPattern(name: string): RegExp {
  return new RegExp(`^[ \\t]*${name}[ \\t]*=`);
}

/** A `#` mention does not count: systemd's `EnvironmentFile=` and `selectServerEntry` skip it. */
export function hasEnvAssignment(content: string, name: string): boolean {
  return content.split('\n').some((line) => assignmentPattern(name).test(line));
}

/**
 * Rewrites every uncommented assignment of `name` in place, or appends one.
 * Commented lines survive, such as a stub's `# KICI_MODE=...`.
 */
export function upsertEnvAssignment(content: string, name: string, value: string): string {
  const pattern = assignmentPattern(name);
  let replaced = false;
  const lines = content.split('\n').map((line) => {
    if (!pattern.test(line)) return line;
    replaced = true;
    return `${name}=${value}`;
  });
  if (replaced) return lines.join('\n');

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(`${name}=${value}`, '');
  return lines.join('\n');
}
