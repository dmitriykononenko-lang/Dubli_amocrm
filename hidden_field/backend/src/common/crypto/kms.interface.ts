/** Зашифрованное значение: шифртекст (+ тег), nonce и ссылка на ключ. */
export interface EncryptedPayload {
  ciphertext: Buffer;
  nonce: Buffer;
  keyRef: string;
}

/**
 * Абстракция шифрования секретов (токенов). Сейчас — AES-256-GCM поверх env-ключа
 * (EnvKmsService). Позже заменяется на Selectel Secrets Manager / Vault без изменения
 * вызывающего кода. Методы асинхронны под будущий сетевой KMS.
 */
export interface KmsService {
  encrypt(plaintext: Buffer | string): Promise<EncryptedPayload>;
  decrypt(input: EncryptedPayload): Promise<Buffer>;
  /** Идентификатор текущего ключа (хранится в oauth_tokens.kms_key_ref). */
  currentKeyRef(): string;
}

export const KMS_SERVICE = Symbol('KMS_SERVICE');
