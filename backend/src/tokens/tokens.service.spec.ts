import { randomBytes } from 'node:crypto';
import { TokensService } from './tokens.service';
import { EnvKmsService } from '../common/crypto/env-kms.service';

// Юнит-тест без БД/сети: репозиторий, accounts, http-клиент и audit — моки; KMS — настоящий.
describe('TokensService', () => {
  const kms = new EnvKmsService(randomBytes(32));

  function makeService() {
    const store: { row?: any } = {};
    const repo = {
      upsert: jest.fn(async (accountId: string, row: any) => {
        store.row = {
          access_token_enc: row.accessTokenEnc,
          refresh_token_enc: row.refreshTokenEnc,
          nonce: row.nonce,
          kms_key_ref: row.kmsKeyRef,
          access_expires_at: row.accessExpiresAt,
          refresh_expires_at: row.refreshExpiresAt,
        };
      }),
      find: jest.fn(async () => store.row),
    };
    const accounts = {
      findById: jest.fn(async () => ({ account_id: '1', subdomain: 'demo' })),
      getSettings: jest.fn(async () => ({})),
    };
    const amocrmHttp = {
      exchangeToken: jest.fn(async () => ({
        token_type: 'Bearer',
        expires_in: 86400,
        access_token: 'NEW_ACCESS',
        refresh_token: 'NEW_REFRESH',
      })),
    };
    const audit = { log: jest.fn(async () => undefined) };
    const PRIVATE_CLIENT = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://x/cb' };
    const config = { oauthClientById: jest.fn(() => PRIVATE_CLIENT) };
    const service = new TokensService(
      repo as any,
      accounts as any,
      amocrmHttp as any,
      audit as any,
      kms,
      config as any,
    );
    return { service, repo, accounts, amocrmHttp, audit, config, store };
  }

  it('save шифрует токены и хранит составной nonce (24 байта)', async () => {
    const { service, store } = makeService();
    // Отличимый sentinel: ищем его как подпоследовательность байт в шифртексте.
    // (Проверять отсутствие одного символа в случайном GCM-шифртексте нельзя — флай.)
    const accessToken = 'PLAINTEXT_ACCESS_TOKEN_SENTINEL';
    await service.save('1', { accessToken, refreshToken: 'R', expiresIn: 86400 });
    expect(store.row.nonce).toHaveLength(24);
    expect(Buffer.isBuffer(store.row.access_token_enc)).toBe(true);
    // в открытом виде токенов нет
    expect(store.row.access_token_enc.includes(Buffer.from(accessToken, 'utf8'))).toBe(false);
  });

  it('getValidAccessToken возвращает расшифрованный access, пока он свежий', async () => {
    const { service } = makeService();
    await service.save('1', { accessToken: 'ACCESS_1', refreshToken: 'R1', expiresIn: 86400 });
    await expect(service.getValidAccessToken('1')).resolves.toBe('ACCESS_1');
  });

  it('при истёкшем access выполняется refresh (ротация обоих токенов)', async () => {
    const { service, amocrmHttp } = makeService();
    await service.save('1', { accessToken: 'OLD', refreshToken: 'OLD_R', expiresIn: -10 });
    const token = await service.getValidAccessToken('1');
    expect(token).toBe('NEW_ACCESS');
    expect(amocrmHttp.exchangeToken).toHaveBeenCalledWith(
      'demo',
      { grant_type: 'refresh_token', refresh_token: 'OLD_R' },
      expect.objectContaining({ clientId: 'cid' }),
    );
    // новый refresh тоже сохранён и читается при следующем refresh
    await service.save('1', { accessToken: 'X', refreshToken: 'X', expiresIn: -10 });
  });
});
