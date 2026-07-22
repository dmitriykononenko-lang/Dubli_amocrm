import { Injectable, NotFoundException } from '@nestjs/common';
import { AmocrmHttpClient } from './amocrm-http.client';
import { TokensService } from '../tokens/tokens.service';
import { AccountsService } from '../accounts/accounts.service';
import { AppConfigService } from '../config/app-config.service';
import { toPlural } from '../common/entity-type.util';
import type { EntityType } from '../common/db/database.types';
import type { RawAmoEntity } from '../entities/field-extractor';

/**
 * Ключ vendor-аккаунта для операций биллинга через ДОЛГОСРОЧНЫЙ токен (env),
 * без OAuth/установки. amocrm.service.ctx распознаёт его и берёт subdomain+token из конфига.
 */
export const VENDOR_ACCOUNT_KEY = 'vendor';

/** Связь сущности amoCRM (для переноса при объединении). */
export interface AmoLink {
  to_entity_id: number;
  to_entity_type: string;
  metadata?: Record<string, unknown>;
}

/** Страница листинга для фонового сканирования. */
export interface AmoPage {
  items: RawAmoEntity[];
  nextPath: string | null;
}

const SCAN_PAGE_LIMIT = 250; // максимум amoCRM v4

/**
 * Высокоуровневый клиент amoCRM: подставляет subdomain и валидный access-токен.
 * Используется для обогащения (вебхуки) и для операций объединения дублей
 * (чтение, обновление, перенос связей, удаление, восстановление при откате).
 */
@Injectable()
export class AmocrmService {
  constructor(
    private readonly http: AmocrmHttpClient,
    private readonly tokens: TokensService,
    private readonly accounts: AccountsService,
    private readonly config: AppConfigService,
  ) {}

  async getById<T = unknown>(accountId: string, entityType: EntityType, amoId: string): Promise<T> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}`;
    return this.http.apiGet<T>(subdomain, accountId, path, accessToken);
  }

  /**
   * Одна страница листинга сущностей (для фонового сканирования). path — курсор
   * (pathname+search из _links.next); пусто → первая страница. Докачка по _links.next.
   */
  async listPage(
    accountId: string,
    entityType: EntityType,
    path?: string | null,
  ): Promise<AmoPage> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const plural = toPlural(entityType);
    const reqPath = path && path.length > 0 ? path : `/api/v4/${plural}?limit=${SCAN_PAGE_LIMIT}`;
    const res = await this.http.apiGet<{
      _embedded?: Record<string, RawAmoEntity[]>;
      _links?: { next?: { href: string } };
    }>(subdomain, accountId, reqPath, accessToken);
    const items = res?._embedded?.[plural] ?? [];
    const nextHref = res?._links?.next?.href ?? null;
    let nextPath: string | null = null;
    if (nextHref) {
      try {
        const u = new URL(nextHref);
        nextPath = u.pathname + u.search;
      } catch {
        nextPath = null;
      }
    }
    return { items, nextPath };
  }

  /** Частичное обновление сущности (PATCH). */
  async update<T = unknown>(
    accountId: string,
    entityType: EntityType,
    amoId: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}`;
    return this.http.apiPatch<T>(subdomain, accountId, path, accessToken, payload);
  }

  /** Удаление сущности (используется при объединении для дубля). */
  async remove(accountId: string, entityType: EntityType, amoId: string): Promise<void> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}`;
    await this.http.apiDelete(subdomain, accountId, path, accessToken);
  }

  /** Связи сущности (links API v4). */
  async getLinks(accountId: string, entityType: EntityType, amoId: string): Promise<AmoLink[]> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}/links`;
    const res = await this.http.apiGet<{ _embedded?: { links?: AmoLink[] } }>(
      subdomain,
      accountId,
      path,
      accessToken,
    );
    return res?._embedded?.links ?? [];
  }

  /** Привязка связей к сущности (перенос связей дубля на главную запись). */
  async link(
    accountId: string,
    entityType: EntityType,
    amoId: string,
    links: AmoLink[],
  ): Promise<void> {
    if (links.length === 0) return;
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${amoId}/link`;
    await this.http.apiPost(subdomain, accountId, path, accessToken, links);
  }

  /** Создание сущности из снимка (восстановление дубля при откате). Возвращает новый amo_id. */
  async create(
    accountId: string,
    entityType: EntityType,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const plural = toPlural(entityType);
    const res = await this.http.apiPost<{ _embedded?: Record<string, Array<{ id: number }>> }>(
      subdomain,
      accountId,
      `/api/v4/${plural}`,
      accessToken,
      [payload],
    );
    const created = res?._embedded?.[plural]?.[0];
    if (!created?.id) throw new Error('amoCRM не вернул id созданной сущности');
    return String(created.id);
  }

  /** Примечание к сущности (лид/контакт/компания). */
  async addNote(
    accountId: string,
    entityType: EntityType,
    entityId: string,
    text: string,
  ): Promise<void> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const path = `/api/v4/${toPlural(entityType)}/${entityId}/notes`;
    await this.http.apiPost(subdomain, accountId, path, accessToken, [
      { note_type: 'common', params: { text } },
    ]);
  }

  /** Задача, привязанная к сущности (для менеджера). */
  async createTask(
    accountId: string,
    input: { entityType: EntityType; entityId: string; text: string; completeTill?: number },
  ): Promise<void> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    await this.http.apiPost(subdomain, accountId, '/api/v4/tasks', accessToken, [
      {
        text: input.text,
        entity_id: Number(input.entityId),
        entity_type: toPlural(input.entityType),
        complete_till: input.completeTill ?? Math.floor(Date.now() / 1000) + 86400,
      },
    ]);
  }

  /** Этапы воронки (id + название) — для резолва статусов по имени. */
  async getPipelineStatuses(
    accountId: string,
    pipelineId: number,
  ): Promise<Array<{ id: number; name: string }>> {
    const { subdomain, accessToken } = await this.ctx(accountId);
    const res = await this.http.apiGet<{
      _embedded?: { statuses?: Array<{ id: number; name: string }> };
    }>(subdomain, accountId, `/api/v4/leads/pipelines/${pipelineId}`, accessToken);
    return res?._embedded?.statuses ?? [];
  }

  /** Резолв subdomain + валидного access-токена для аккаунта. */
  private async ctx(accountId: string): Promise<{ subdomain: string; accessToken: string }> {
    // Vendor-аккаунт по долгосрочному токену (биллинг) — без OAuth и без записи в БД.
    const va = this.vendorAuth();
    if (va && (accountId === VENDOR_ACCOUNT_KEY || accountId === this.config.vendorAmocrmAccountId)) {
      return va;
    }
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundException('Аккаунт не найден');
    const accessToken = await this.tokens.getValidAccessToken(accountId);
    return { subdomain: account.subdomain, accessToken };
  }

  /** subdomain + долгосрочный токен vendor-аккаунта из конфига, либо null. */
  private vendorAuth(): { subdomain: string; accessToken: string } | null {
    const token = this.config.vendorAmocrmToken;
    const sub = this.config.vendorAmocrmSubdomain;
    if (token && sub) return { subdomain: sub.split('.')[0], accessToken: token };
    return null;
  }
}
