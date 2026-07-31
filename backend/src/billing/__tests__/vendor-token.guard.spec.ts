import { UnauthorizedException } from '@nestjs/common';
import { VendorTokenGuard } from '../vendor-token.guard';
import type { AppConfigService } from '../../config/app-config.service';

function ctx(headerVal?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (n: string) => (n.toLowerCase() === 'x-vendor-token' ? headerVal : undefined),
      }),
    }),
  } as never;
}
const guard = (token?: string) => new VendorTokenGuard({ vendorAdminToken: token } as AppConfigService);

describe('VendorTokenGuard', () => {
  it('VENDOR_ADMIN_TOKEN не задан → доступ закрыт (401)', () => {
    expect(() => guard(undefined).canActivate(ctx('whatever'))).toThrow(UnauthorizedException);
  });

  it('нет заголовка X-Vendor-Token → 401', () => {
    expect(() => guard('secret-xyz').canActivate(ctx(undefined))).toThrow(UnauthorizedException);
  });

  it('неверный токен → 401', () => {
    expect(() => guard('secret-xyz').canActivate(ctx('nope'))).toThrow(UnauthorizedException);
  });

  it('верный токен → доступ разрешён', () => {
    expect(guard('secret-xyz').canActivate(ctx('secret-xyz'))).toBe(true);
  });
});
