/** Parse JSON, returning null for empty, nullish or invalid input. */
export function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
