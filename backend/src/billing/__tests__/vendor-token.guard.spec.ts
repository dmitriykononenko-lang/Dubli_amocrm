import { UnauthorizedException } from '@nestjs/common';
import { VendorTokenGuard } from '../vendor-token.guard';
import { signSession, SESSION_COOKIE } from '../vendor-session';
import type { AppConfigService } from '../../config/app-config.service';

const SECRET = 'session-secret-xyz';

function ctx(headers: { token?: string; cookie?: string }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (n: string) => {
          const k = n.toLowerCase();
          if (k === 'x-vendor-token') return headers.token;
          if (k === 'cookie') return headers.cookie;
          return undefined;
        },
      }),
    }),
  } as never;
}
const guard = (token?: string, sessionSecret?: string) =>
  new VendorTokenGuard({ vendorAdminToken: token, billingAdminSessionSecret: sessionSecret } as AppConfigService);
const cookieFor = (payload: { role: string; exp: number }) =>
  `${SESSION_COOKIE}=${signSession(SECRET, { u: 'op', ...payload })}`;

describe('VendorTokenGuard (токен ИЛИ сессия)', () => {
  it('ничего не настроено → доступ закрыт (401)', () => {
    expect(() => guard(undefined, undefined).canActivate(ctx({ token: 'x' }))).toThrow(UnauthorizedException);
  });

  it('верный X-Vendor-Token → доступ', () => {
    expect(guard('secret-xyz').canActivate(ctx({ token: 'secret-xyz' }))).toBe(true);
  });

  it('неверный токен и нет сессии → 401', () => {
    expect(() => guard('secret-xyz', SECRET).canActivate(ctx({ token: 'nope' }))).toThrow(UnauthorizedException);
  });

  it('валидная сессионная cookie (billing_admin) → доступ', () => {
    const cookie = cookieFor({ role: 'billing_admin', exp: Date.now() + 60_000 });
    expect(guard('t', SECRET).canActivate(ctx({ cookie }))).toBe(true);
  });

  it('истёкшая сессия → 401', () => {
    const cookie = cookieFor({ role: 'billing_admin', exp: Date.now() - 1000 });
    expect(() => guard(undefined, SECRET).canActivate(ctx({ cookie }))).toThrow(UnauthorizedException);
  });

  it('чужая роль в сессии → 401', () => {
    const cookie = cookieFor({ role: 'guest', exp: Date.now() + 60_000 });
    expect(() => guard(undefined, SECRET).canActivate(ctx({ cookie }))).toThrow(UnauthorizedException);
  });
});
