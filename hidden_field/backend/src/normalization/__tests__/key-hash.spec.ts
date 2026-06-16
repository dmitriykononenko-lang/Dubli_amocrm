import { createHash } from 'node:crypto';
import { keyHash } from '../key-hash.util';

describe('keyHash', () => {
  it('возвращает 32 байта (SHA-256)', () => {
    expect(keyHash('phone', '9991234567')).toHaveLength(32);
  });

  it('детерминирован', () => {
    expect(keyHash('email', 'a@b.com').equals(keyHash('email', 'a@b.com'))).toBe(true);
  });

  it('соответствует формуле SHA-256(key_type || ":" || normalized)', () => {
    const expected = createHash('sha256').update('phone:9991234567', 'utf8').digest();
    expect(keyHash('phone', '9991234567').equals(expected)).toBe(true);
  });

  it('разный key_type при одном значении → разный хэш', () => {
    expect(keyHash('phone', '123').equals(keyHash('custom', '123'))).toBe(false);
  });

  it('разные значения → разный хэш', () => {
    expect(keyHash('email', 'a@b.com').equals(keyHash('email', 'c@d.com'))).toBe(false);
  });
});
