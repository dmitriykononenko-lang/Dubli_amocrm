import { DEFAULT_DEDUP, normalizeDedup } from '../dedup-settings';

describe('normalizeDedup', () => {
  it('пустой вход → дефолты', () => {
    expect(normalizeDedup(undefined)).toEqual(DEFAULT_DEDUP);
    expect(normalizeDedup({})).toEqual(DEFAULT_DEDUP);
  });

  it('частичные entities дополняются дефолтами', () => {
    const r = normalizeDedup({ entities: { company: false } });
    expect(r.entities).toEqual({ contact: true, company: false, lead: true });
  });

  it('коэрсит булевы значения (строки/числа)', () => {
    const r = normalizeDedup({
      entities: { contact: 'false', company: 1, lead: '0' },
      prevent_create: 'true',
    });
    expect(r.entities).toEqual({ contact: false, company: true, lead: false });
    expect(r.prevent_create).toBe(true);
  });

  it('мусорные значения → дефолты для поля', () => {
    const r = normalizeDedup({ entities: { contact: 'maybe' }, prevent_create: {} });
    expect(r.entities.contact).toBe(true);
    expect(r.prevent_create).toBe(false);
  });
});
