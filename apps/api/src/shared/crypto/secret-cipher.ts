/**
 * Symmetric encryption for the credentials of a *target* API — the tokens the runner will
 * present when it calls somebody's staging environment.
 *
 * Encrypted rather than hashed, because unlike a password these have to be replayed. AES-256-GCM
 * so a tampered ciphertext fails to decrypt instead of decrypting to garbage that then gets sent
 * as an Authorization header.
 *
 * The key comes from `SECRETS_KEY` and never from the database: a dump of the database alone
 * must not be enough to recover a customer's staging token.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_CIPHER = Symbol("SECRET_CIPHER");

export interface SecretCipherPort {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

export class AesGcmSecretCipher implements SecretCipherPort {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("SECRETS_KEY debe ser una clave de 32 bytes en base64");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(
      ".",
    );
  }

  decrypt(payload: string): string {
    const [version, iv, tag, encrypted] = payload.split(".");
    if (version !== "v1") throw new Error("Formato de secreto no reconocido");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  }
}
