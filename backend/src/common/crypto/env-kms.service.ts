import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedPayload, KmsService } from './kms.interface';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12; // рекомендованный размер IV для GCM
const TAG_LEN = 16;
const KEY_REF = 'env:v1';

/**
 * AES-256-GCM поверх мастер-ключа из окружения (TOKEN_ENC_KEY).
 * Шифртекст хранится как (ciphertext || authTag); nonce — отдельно (новый на каждое шифрование).
 */
export class EnvKmsService implements KmsService {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('TOKEN_ENC_KEY должен быть ровно 32 байта (AES-256)');
    }
    this.key = key;
  }

  currentKeyRef(): string {
    return KEY_REF;
  }

  async encrypt(plaintext: Buffer | string): Promise<EncryptedPayload> {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGO, this.key, nonce);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([enc, tag]), nonce, keyRef: KEY_REF };
  }

  async decrypt(input: EncryptedPayload): Promise<Buffer> {
    const { ciphertext, nonce } = input;
    if (ciphertext.length < TAG_LEN) {
      throw new Error('Некорректный шифртекст: слишком короткий');
    }
    const enc = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
}
