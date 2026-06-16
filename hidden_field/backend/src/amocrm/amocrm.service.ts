import { Injectable, NotFoundException } from '@nestjs/common';
import { AmocrmHttpClient } from './amocrm-http.client';
import { TokensService } from '../tokens/tokens.service';
import { AccountsService } from '../accounts/accounts.service';
import { toPlural } from '../common/entity-type.util';
import type { EntityType } from '../common/db/database.types';

export interface AmoCustomField {
  id: number;
  name: string;
  type?: string;
  code?: string | null;
}

export interface AmoUser {
  id: number;
  name: string;
}

export interface AmoPipeline {
  id: number;
  name: string;
}

/**
 * Высокоуровневый клиент amoCRM: подставляет subdomain и валидный access-токен.
 * Для виджета Hidden Field читает метаданные аккаунта — поля, пользователей, воронки —
 * чтобы построить матрицу «поле × сотрудник» на экране настроек.
 */
@Injectable()
export class AmocrmService {
  constructor(
    private readonly http: AmocrmHttpClient,
    private readonly tokens: TokensService,
    private readonly accounts: AccountsService,
  ) {}

  private async context(accountId: string): Promise<{ subdomain: string; token: string }> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundException('Аккаунт не найден');
    const token = await this.tokens.getValidAccessToken(accountId);
    return { subdomain: account.subdomain, token };
  }

  /** Кастомные поля сущности (lead/contact/company). */
  async getCustomFields(accountId: string, entityType: EntityType): Promise<AmoCustomField[]> {
    const { subdomain, token } = await this.context(accountId);
    const resp = await this.http.apiGet<{ _embedded?: { custom_fields?: AmoCustomField[] } }>(
      subdomain,
      accountId,
      `/api/v4/${toPlural(entityType)}/custom_fields?limit=250`,
      token,
    );
    return resp._embedded?.custom_fields ?? [];
  }

  /** Пользователи аккаунта. */
  async getUsers(accountId: string): Promise<AmoUser[]> {
    const { subdomain, token } = await this.context(accountId);
    const resp = await this.http.apiGet<{ _embedded?: { users?: AmoUser[] } }>(
      subdomain,
      accountId,
      `/api/v4/users?limit=250`,
      token,
    );
    return resp._embedded?.users ?? [];
  }

  /** Воронки сделок (для правил этапов/воронок — задел на следующие очереди). */
  async getPipelines(accountId: string): Promise<AmoPipeline[]> {
    const { subdomain, token } = await this.context(accountId);
    const resp = await this.http.apiGet<{ _embedded?: { pipelines?: AmoPipeline[] } }>(
      subdomain,
      accountId,
      `/api/v4/leads/pipelines`,
      token,
    );
    return resp._embedded?.pipelines ?? [];
  }
}
