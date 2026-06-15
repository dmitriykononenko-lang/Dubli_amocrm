import { Injectable } from '@nestjs/common';
import type { KeyType } from '../common/db/database.types';
import { normalizePhone } from './phone.normalizer';
import { normalizeEmail } from './email.normalizer';
import { normalizeInn } from './inn.normalizer';
import { normalizeName } from './name.normalizer';
import { keyHash } from './key-hash.util';

export interface RawField {
  key_type: KeyType;
  value: string;
}

export interface NormalizedKey {
  key_type: KeyType;
  key_norm: string;
  key_hash: Buffer;
}

/** Фасад нормализации: сырые поля сущности → нормализованные ключи для entity_keys. */
@Injectable()
export class NormalizationService {
  normalizeValue(
    keyType: KeyType,
    value: string,
    opts: { isCompany?: boolean } = {},
  ): string | null {
    switch (keyType) {
      case 'phone':
        return normalizePhone(value);
      case 'email':
        return normalizeEmail(value);
      case 'inn':
        return normalizeInn(value);
      case 'name':
        return normalizeName(value, { stripOpf: opts.isCompany });
      case 'custom':
      default: {
        const v = String(value ?? '')
          .trim()
          .toLowerCase();
        return v || null;
      }
    }
  }

  buildKeys(fields: RawField[], opts: { isCompany?: boolean } = {}): NormalizedKey[] {
    const out: NormalizedKey[] = [];
    for (const f of fields) {
      const norm = this.normalizeValue(f.key_type, f.value, opts);
      if (norm === null) continue;
      out.push({ key_type: f.key_type, key_norm: norm, key_hash: keyHash(f.key_type, norm) });
    }
    return out;
  }
}
