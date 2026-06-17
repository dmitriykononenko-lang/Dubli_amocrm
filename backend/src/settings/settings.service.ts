import { Injectable } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { normalizeDedup, type DedupSettings } from './dedup-settings';

/** Чтение/запись настроек дедупликации в accounts.settings.dedup (прочие ключи не трогаем). */
@Injectable()
export class SettingsService {
  constructor(private readonly accounts: AccountsService) {}

  async get(accountId: string): Promise<DedupSettings> {
    const settings = await this.accounts.getSettings(accountId);
    return normalizeDedup(settings.dedup);
  }

  async save(accountId: string, dedup: DedupSettings): Promise<DedupSettings> {
    const settings = await this.accounts.getSettings(accountId);
    await this.accounts.updateSettings(accountId, { ...settings, dedup });
    return dedup;
  }
}
