import { randomBytes } from 'node:crypto';
import { EnvKmsService } from './env-kms.service';

describe('EnvKmsService (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const svc = new EnvKmsService(key);

  it('round-trip: расшифровка возвращает исходный текст', async () => {
    const enc = await svc.encrypt('секретный токен amoCRM 🔐');
    const dec = await svc.decrypt(enc);
    expect(dec.toString('utf8')).toBe('секретный токен amoCRM 🔐');
  });

  it('round-trip для Buffer', async () => {
    const raw = randomBytes(64);
    const enc = await svc.encrypt(raw);
    expect((await svc.decrypt(enc)).equals(raw)).toBe(true);
  });

  it('каждое шифрование даёт новый nonce и иной шифртекст', async () => {
    const a = await svc.encrypt('one');
    const b = await svc.encrypt('one');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('keyRef = env:v1', async () => {
    expect(svc.currentKeyRef()).toBe('env:v1');
    expect((await svc.encrypt('x')).keyRef).toBe('env:v1');
  });

  it('порча шифртекста/тега → ошибка дешифровки', async () => {
    const enc = await svc.encrypt('data');
    enc.ciphertext[enc.ciphertext.length - 1] ^= 0xff;
    await expect(svc.decrypt(enc)).rejects.toThrow();
  });

  it('чужой ключ не расшифровывает', async () => {
    const enc = await svc.encrypt('data');
    const other = new EnvKmsService(randomBytes(32));
    await expect(other.decrypt(enc)).rejects.toThrow();
  });

  it('неверная длина ключа → ошибка в конструкторе', () => {
    expect(() => new EnvKmsService(randomBytes(16))).toThrow();
    expect(() => new EnvKmsService(randomBytes(31))).toThrow();
  });
});
