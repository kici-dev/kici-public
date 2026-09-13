/**
 * Single-variable upsert for service env-file content.
 *
 * The sibling {@link ./deploy-env.js} upserts a whole `KICI_DEPLOY_*` block by
 * stripping the prefix and re-appending it. A variable an operator may also
 * have set by hand needs the narrower shape: replace the assignment where it
 * already sits, so the comment above it still describes the value below it.
 */

/** Matches an uncommented `NAME=` assignment, the same shape startup reads. */
function assignmentPattern(name: string): RegExp {
  return new RegExp(`^[ \\t]*${name}[ \\t]*=`);
}

/**
 * Whether `content` carries an uncommented assignment of `name`.
 *
 * A `#`-prefixed mention does not count: it is documentation, and the readers
 * that matter (systemd's `EnvironmentFile=`, `selectServerEntry`) skip it.
 */
export function hasEnvAssignment(content: string, name: string): boolean {
  return content.split('\n').some((line) => assignmentPattern(name).test(line));
}

/**
 * Return `content` with `name` assigned `value`.
 *
 * Every uncommented assignment of `name` is rewritten in place; a file that
 * declares it nowhere gains the assignment on its last line. Commented lines
 * are left alone, so a stub's explanatory `# KICI_MODE=...` survives.
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
