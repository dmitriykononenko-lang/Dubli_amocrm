import { signSession, verifySession, parseCookies, safeEqual } from '../vendor-session';

const SECRET = 'a-strong-secret';

describe('vendor-session', () => {
  it('sign→verify round-trip возвращает payload', () => {
    const token = signSession(SECRET, { u: 'op', role: 'billing_admin', exp: Date.now() + 60_000 });
    const p = verifySession(SECRET, token);
    expect(p?.u).toBe('op');
    expect(p?.role).toBe('billing_admin');
  });

  it('чужой секрет не проходит', () => {
    const token = signSession(SECRET, { u: 'op', role: 'billing_admin', exp: Date.now() + 60_000 });
    expect(verifySession('other-secret', token)).toBeNull();
  });

  it('подделка тела → null', () => {
    const token = signSession(SECRET, { u: 'op', role: 'billing_admin', exp: Date.now() + 60_000 });
    const tampered = 'Zm9v' + token.slice(4); // портим начало payload
    expect(verifySession(SECRET, tampered)).toBeNull();
  });

  it('истёкший токен → null', () => {
    const token = signSession(SECRET, { u: 'op', role: 'billing_admin', exp: Date.now() - 1 });
    expect(verifySession(SECRET, token)).toBeNull();
  });

  it('parseCookies разбирает заголовок', () => {
    expect(parseCookies('a=1; dubli_admin=xyz; b=2').dubli_admin).toBe('xyz');
    expect(parseCookies(undefined)).toEqual({});
  });

  it('safeEqual: равные/разные', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
