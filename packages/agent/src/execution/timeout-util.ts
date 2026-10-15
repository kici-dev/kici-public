/** Deadline for init-runner dynamic field evaluation and dynamic job function evaluation. */
export async function withTimeout<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const result = await Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () =>
          reject(new Error(`Timeout after ${timeoutMs}ms evaluating ${label}`)),
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
