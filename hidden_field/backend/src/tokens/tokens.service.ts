import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokensRepository } from './tokens.repository';
import { AccountsService } from '../accounts/accounts.service';
import { AmocrmHttpClient } from '../amocrm/amocrm-http.client';
import { AuditService } from '../common/audit/audit.service';
import { KMS_SERVICE, type KmsService } from '../common/crypto/kms.interface';

const NONCE_LEN = 12;
// amoCRM refresh-токен живёт ~3 месяца; точного expiry в ответе нет — берём 90 дней.
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Обновляем access заранее, не дожидаясь точного истечения.
const REFRESH_SKEW_MS = 60 * 1000;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // секунды (expires_in от amoCRM)
}

/**
 * Хранение/обновление OAuth-токенов amoCRM.
 * Шифрование AES-GCM через KmsService. Один nonce-столбец хранит два IV (access || refresh),
 * по 12 байт каждый — схема oauth_tokens остаётся неизменной.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly repo: TokensRepository,
    private readonly accounts: AccountsService,
    private readonly amocrmHttp: AmocrmHttpClient,
    private readonly audit: AuditService,
    @Inject(KMS_SERVICE) private readonly kms: KmsService,
  ) {}

  async save(accountId: string, tokens: OAuthTokens): Promise<void> {
    const encAccess = await this.kms.encrypt(tokens.accessToken);
    const encRefresh = await this.kms.encrypt(tokens.refreshToken);
    const now = Date.now();
    await this.repo.upsert(accountId, {
      accessTokenEnc: encAccess.ciphertext,
      refreshTokenEnc: encRefresh.ciphertext,
      nonce: Buffer.concat([encAccess.nonce, encRefresh.nonce]), // 24 байта = два IV
      kmsKeyRef: this.kms.currentKeyRef(),
      accessExpiresAt: new Date(now + tokens.expiresIn * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
    });
  }

  /** Валидный access-токен; при близком истечении — прозрачный refresh. */
  async getValidAccessToken(accountId: string): Promise<string> {
    const row = await this.repo.find(accountId);
    if (!row) throw new UnauthorizedException('Нет токенов для аккаунта');
    if (row.access_expires_at.getTime() - Date.now() < REFRESH_SKEW_MS) {
      return this.refresh(accountId);
    }
    const ivAccess = row.nonce.subarray(0, NONCE_LEN);
    const access = await this.kms.decrypt({
      ciphertext: row.access_token_enc,
      nonce: ivAccess,
      keyRef: row.kms_key_ref,
    });
    return access.toString('utf8');
  }

  /** Обновление пары токенов (amoCRM ротирует оба). Возвращает новый access-токен. */
  async refresh(accountId: string): Promise<string> {
    const row = await this.repo.find(accountId);
    if (!row) throw new UnauthorizedException('Нет токенов для аккаунта');
    const account = await this.accounts.findById(accountId);
    if (!account) throw new UnauthorizedException('Аккаунт не найден');

    const ivRefresh = row.nonce.subarray(NONCE_LEN, NONCE_LEN * 2);
    const refreshToken = (
      await this.kms.decrypt({
        ciphertext: row.refresh_token_enc,
        nonce: ivRefresh,
        keyRef: row.kms_key_ref,
      })
    ).toString('utf8');

    const resp = await this.amocrmHttp.exchangeToken(account.subdomain, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    await this.save(accountId, {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresIn: resp.expires_in,
    });
    await this.audit.log({ accountId, action: 'token_use', meta: { op: 'refresh' } });
    return resp.access_token;
  }
}
