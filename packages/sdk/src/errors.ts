/**
 * Thrown when accessing a secret key that does not exist in the flat secrets proxy.
 */
export class SecretNotFoundError extends Error {
  constructor(
    public readonly key: string,
    public readonly availableKeys: string[],
  ) {
    super(
      `Secret "${key}" not found. Available keys: ${availableKeys.join(', ') || '(none)'}. Use ctx.secrets.has('${key}') to check existence, or await ctx.secrets.get('${key}') in a try/catch.`,
    );
    this.name = 'SecretNotFoundError';
  }
}
