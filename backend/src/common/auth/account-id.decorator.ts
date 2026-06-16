import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Свойство запроса, куда ApiSecurityGuard кладёт проверенный account_id. */
export const ACCOUNT_ID_PROP = 'accountId';

/**
 * Инъекция проверенного account_id в обработчик. Значение ставит ApiSecurityGuard
 * после сверки security_key — контроллер всегда работает в скоупе аутентифицированного аккаунта.
 */
export const AccountId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request & { [ACCOUNT_ID_PROP]?: string }>();
  return req[ACCOUNT_ID_PROP] ?? '';
});
