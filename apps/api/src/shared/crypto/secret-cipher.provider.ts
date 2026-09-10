import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { AesGcmSecretCipher, type SecretCipherPort } from "./secret-cipher";

/**
 * The cipher, keyed from the environment.
 *
 * **It refuses to work without `SECRETS_KEY` rather than falling back to a fixed key.** A
 * default key is the same as no encryption at all, and worse, because the ciphertext in the
 * database looks like it means something. Storing a credential is the first operation that needs
 * it, so the failure lands on the person configuring the deployment rather than months later on
 * whoever has to explain the breach.
 */
@Injectable()
export class SecretCipherProvider implements SecretCipherPort {
  private cipher: AesGcmSecretCipher | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  private get delegate(): AesGcmSecretCipher {
    if (!this.env.SECRETS_KEY) {
      throw new Error(
        "SECRETS_KEY no está configurada: no se pueden guardar credenciales de destino ni variables secretas",
      );
    }
    this.cipher ??= new AesGcmSecretCipher(this.env.SECRETS_KEY);
    return this.cipher;
  }

  encrypt(plain: string): string {
    return this.delegate.encrypt(plain);
  }
  decrypt(payload: string): string {
    return this.delegate.decrypt(payload);
  }
}
