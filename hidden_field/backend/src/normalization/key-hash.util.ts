import { createHash } from 'node:crypto';
import type { KeyType } from '../common/db/database.types';

/**
 * Ключ точного совпадения (§6.2): key_hash = SHA-256(key_type || ':' || normalized).
 * Возвращает 32-байтный Buffer для колонки BYTEA entity_keys.key_hash.
 */
export function keyHash(keyType: KeyType, normalized: string): Buffer {
  return createHash('sha256').update(`${keyType}:${normalized}`, 'utf8').digest();
}
