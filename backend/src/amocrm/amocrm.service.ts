import { Injectable, NotFoundException } from '@nestjs/common';
import { AmocrmHttpClient } from './amocrm-http.client';
import { TokensService } from '../tokens/tokens.service';
import { AccountsService } from '../accounts/accounts.service';
import { toPlural } from '../common/entity-type.util';
import type { EntityType } from '../common/db/database.types';

/**
 * Высокоуровневый клиент amoCRM: подставляет subdomain и валидный access-токен.
 * В ядре используется для точечного обогащения (если в вебхуке мало полей);
 * листинги/пагинация — на этапе массового сканирования.
 */
@Injectable()
export class AmocrmService {
  constructor(
    private readonly http: AmocrmHttpClient,
    private readonly tokens: TokensService,
    private readonly accounts: AccountsService,
  ) {}

  async getById<T = unknown>(accountId: string, entityType: EntityType, amoId: string): Promise<T> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundException('Аккаунт не найден');
    const accessToken = await this.tokens.getValidAccessToken(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}`;
    return this.http.apiGet<T>(account.subdomain, accountId, path, accessToken);
  }
}
