import { Injectable } from '@nestjs/common';
import { AccountsRepository } from './accounts.repository';
import type { AccountSettings } from '../common/db/database.types';

@Injectable()
export class AccountsService {
  constructor(private readonly repo: AccountsRepository) {}

  upsert(input: { accountId: string; subdomain: string; status?: string }): Promise<void> {
    return this.repo.upsert(input);
  }

  findById(accountId: string) {
    return this.repo.findById(accountId);
  }

  getSettings(accountId: string): Promise<AccountSettings> {
    return this.repo.getSettings(accountId);
  }

  /** security_key для проверки вебхуков: из настроек аккаунта (приоритет над env-фолбэком). */
  async getSecurityKey(accountId: string): Promise<string | null> {
    const settings = await this.repo.getSettings(accountId);
    return settings.security_key ?? null;
  }
}
