/** A Platform refused this CLI as newer than itself. Import-free, for the CLI entry point. */
export class ClientNewerThanPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientNewerThanPlatformError';
  }
}
