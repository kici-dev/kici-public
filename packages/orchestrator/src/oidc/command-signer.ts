/**
 * Generic external signer: KiCI shells out to an operator-provided command for
 * every signing operation, so the operator's small script can talk to GCP KMS /
 * Azure Key Vault / Vault transit / a PKCS#11 HSM / anything. The private key
 * never exists inside KiCI.
 *
 * Command contract (stable extension point — documented in
 * docs/operator/orchestrator/signing-keys.md):
 *
 *   `<command> get-public-jwk`
 *       stdout: the public key as a JWK JSON object (kty EC, crv P-256). KiCI
 *       enriches it (alg/use/kid) if those members are absent.
 *
 *   `<command> sign`
 *       stdin:  the base64 of the exact bytes to sign (the JWS signing input).
 *       stdout: the base64 of the JOSE-raw (r||s, 64-byte) ES256 signature.
 *
 * The command is operator-controlled config, never attacker-controlled — same
 * trust level as any other orchestrator configuration.
 */
import { execFile } from 'node:child_process';
import { calculateJwkThumbprint, type JWK } from 'jose';
import type { Signer } from './signer.js';

/** Run `command <subcommand>`, optionally writing `stdin`, resolving trimmed stdout. */
function runSignerCommand(command: string, subcommand: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [subcommand],
      { maxBuffer: 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`signer command failed (${subcommand}): ${stderr || err.message}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/** Enrich a bare public JWK from the command with alg/use/kid if absent. */
async function enrichPublicJwk(raw: JWK): Promise<JWK> {
  if (raw.kty !== 'EC' || raw.crv !== 'P-256') {
    throw new Error('command signer public JWK must be EC P-256 (kty=EC, crv=P-256)');
  }
  const jwk: JWK = { kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y, alg: 'ES256', use: 'sig' };
  jwk.kid = raw.kid ?? (await calculateJwkThumbprint(jwk, 'sha256'));
  return jwk;
}

export class CommandSigner implements Signer {
  readonly alg = 'ES256' as const;
  readonly signerKind = 'command';
  readonly keyRef: string;

  private constructor(
    private readonly command: string,
    private readonly publicJwk: JWK,
  ) {
    this.keyRef = command;
  }

  /** Resolve the public JWK once (via `<command> get-public-jwk`) and build the signer. */
  static async create(opts: { command: string }): Promise<CommandSigner> {
    const out = await runSignerCommand(opts.command, 'get-public-jwk');
    const raw = JSON.parse(out) as JWK;
    const publicJwk = await enrichPublicJwk(raw);
    return new CommandSigner(opts.command, publicJwk);
  }

  /** Build directly from a known public JWK (tests / preloaded material). */
  static async fromPublicJwk(opts: { command: string; publicJwk: JWK }): Promise<CommandSigner> {
    const publicJwk = await enrichPublicJwk(opts.publicJwk);
    return new CommandSigner(opts.command, publicJwk);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const b64 = Buffer.from(data).toString('base64');
    const out = await runSignerCommand(this.command, 'sign', b64);
    const sig = Buffer.from(out, 'base64');
    if (sig.length !== 64) {
      throw new Error(`command signer returned a ${sig.length}-byte signature, expected 64 (r||s)`);
    }
    return new Uint8Array(sig);
  }

  async getPublicJwk(): Promise<JWK> {
    return this.publicJwk;
  }

  async getKid(): Promise<string> {
    return this.publicJwk.kid as string;
  }
}
