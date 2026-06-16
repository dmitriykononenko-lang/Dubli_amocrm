import { normalizeEmail } from '../email.normalizer';

describe('normalizeEmail', () => {
  it('trim + lowercase', () => {
    expect(normalizeEmail('  Test@Example.COM ')).toBe('test@example.com');
  });

  it('без флага gmail точки и +alias сохраняются', () => {
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
  });

  it('с флагом gmailAliases точки и +alias убираются для gmail', () => {
    expect(normalizeEmail('a.b+tag@gmail.com', { gmailAliases: true })).toBe('ab@gmail.com');
    expect(normalizeEmail('John.Doe@googlemail.com', { gmailAliases: true })).toBe(
      'johndoe@googlemail.com',
    );
  });

  it('для не-gmail домена точки не трогаем даже с флагом', () => {
    expect(normalizeEmail('a.b@yandex.ru', { gmailAliases: true })).toBe('a.b@yandex.ru');
  });

  it('невалидные → null', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('@gmail.com')).toBeNull();
    expect(normalizeEmail('user@')).toBeNull();
    expect(normalizeEmail('user@localhost')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});
