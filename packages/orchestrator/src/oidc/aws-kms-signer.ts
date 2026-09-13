import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { JWK } from 'jose';
import { type Signer, derSpkiToPublicJwk, derToRawEcdsaSignature } from './signer.js';

/** Minimal surface of the KMS client we use (so tests can inject a fake). */
export interface KmsLike {
  send(command: unknown): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array }>;
}

export interface AwsKmsSignerOptions {
  client: KmsLike;
  keyArn: string;
}

/**
 * Signs with an AWS KMS asymmetric ECC_NIST_P256 key (ES256). The private key
 * never leaves KMS; sign() is a kms:Sign call. getPublicJwk() resolves once via
 * kms:GetPublicKey and is cached. Ported verbatim from the Platform.
 */
export class AwsKmsSigner implements Signer {
  readonly alg = 'ES256' as const;
  readonly signerKind = 'aws-kms';
  readonly keyRef: string;
  private cachedJwk?: JWK;

  constructor(private readonly opts: AwsKmsSignerOptions) {
    this.keyRef = opts.keyArn;
  }

  /** Build a KMS client with explicit, dedicated AWS creds (NOT the ambient AWS_* chain). */
  static fromCredentials(opts: {
    keyArn: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  }): AwsKmsSigner {
    const client = new KMSClient({
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    return new AwsKmsSigner({ client: client as unknown as KmsLike, keyArn: opts.keyArn });
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const res = await this.opts.client.send(
      new SignCommand({
        KeyId: this.opts.keyArn,
        Message: data,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!res.Signature) throw new Error('KMS Sign returned no signature');
    return derToRawEcdsaSignature(new Uint8Array(res.Signature), 32);
  }

  async getPublicJwk(): Promise<JWK> {
    if (!this.cachedJwk) {
      const res = await this.opts.client.send(new GetPublicKeyCommand({ KeyId: this.opts.keyArn }));
      if (!res.PublicKey) throw new Error('KMS GetPublicKey returned no key');
      this.cachedJwk = await derSpkiToPublicJwk(new Uint8Array(res.PublicKey));
    }
    return this.cachedJwk;
  }

  async getKid(): Promise<string> {
    return (await this.getPublicJwk()).kid as string;
  }
}
