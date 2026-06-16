import { Module } from '@nestjs/common';
import { AccountsModule } from '../../accounts/accounts.module';
import { ApiSecurityGuard } from './api-security.guard';

/**
 * Аутентификация API-запросов виджета. Экспортирует ApiSecurityGuard для фичевых модулей.
 * AccountsModule реэкспортируется: @UseGuards создаёт guard в контексте модуля-контроллера,
 * поэтому AccountsService должен быть виден импортёрам.
 */
@Module({
  imports: [AccountsModule],
  providers: [ApiSecurityGuard],
  exports: [ApiSecurityGuard, AccountsModule],
})
export class ApiAuthModule {}
