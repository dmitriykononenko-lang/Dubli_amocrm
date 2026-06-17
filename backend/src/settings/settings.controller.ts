import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { SettingsService } from './settings.service';
import { normalizeDedup, type DedupSettings } from './dedup-settings';

/** Настройки дедупликации для экрана настроек виджета. */
@Controller('api/settings')
@UseGuards(ApiSecurityGuard)
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  get(@AccountId() accountId: string): Promise<DedupSettings> {
    return this.service.get(accountId);
  }

  @Put()
  save(@AccountId() accountId: string, @Body() body: unknown): Promise<DedupSettings> {
    return this.service.save(accountId, normalizeDedup(body));
  }
}
