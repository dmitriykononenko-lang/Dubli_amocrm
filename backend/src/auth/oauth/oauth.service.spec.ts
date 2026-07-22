import { MockAgent, setGlobalDispatcher } from 'undici';
import { AmocrmHttpClient } from '../../amocrm/amocrm-http.client';
import { OauthService } from './oauth.service';

// Юнит-тест OAuth без БД/сети: amoCRM замокан через undici MockAgent;
// accounts/tokens/audit — моки. Заодно покрывает AmocrmHttpClient.
describe('OauthService.handleInstall', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  function httpClient(): AmocrmHttpClient {
    const config = {
      amocrmClientId: 'cid',
      amocrmClientSecret: 'secret',
      amocrmRedirectUri: 'https://example.com/oauth/callback',
      rateLimitRps: 7,
    };
    return new AmocrmHttpClient(config as never);
  }

  it('обменивает code, получает account_id, сохраняет аккаунт и токены', async () => {
    const pool = agent.get('https://demo.amocrm.ru');
    pool.intercept({ path: '/oauth2/access_token', method: 'POST' }).reply(200, {
      token_type: 'Bearer',
      expires_in: 86400,
      access_token: 'AT',
      refresh_token: 'RT',
    });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 777 });

    const accounts = { upsert: jest.fn(async () => undefined) };
    const tokens = { save: jest.fn(async () => undefined) };
    const audit = { log: jest.fn(async () => undefined) };
    const billing = { onClientInstalled: jest.fn(async () => undefined) };
    const svc = new OauthService(
      httpClient(),
      accounts as never,
      tokens as never,
      audit as never,
      billing as never,
    );

    const res = await svc.handleInstall({ code: 'CODE', referer: 'demo.amocrm.ru' });

    expect(res).toEqual({ accountId: '777', subdomain: 'demo' });
    expect(billing.onClientInstalled).toHaveBeenCalledWith('777');
    expect(accounts.upsert).toHaveBeenCalledWith({
      accountId: '777',
      subdomain: 'demo',
      status: 'active',
    });
    expect(tokens.save).toHaveBeenCalledWith('777', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresIn: 86400,
    });
    expect(audit.log).toHaveBeenCalled();
  });

  it('извлекает subdomain из полного URL referer', async () => {
    const pool = agent.get('https://acme.amocrm.ru');
    pool
      .intercept({ path: '/oauth2/access_token', method: 'POST' })
      .reply(200, { token_type: 'Bearer', expires_in: 1, access_token: 'a', refresh_token: 'r' });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 1 });

    const svc = new OauthService(
      httpClient(),
      { upsert: jest.fn(async () => undefined) } as never,
      { save: jest.fn(async () => undefined) } as never,
      { log: jest.fn(async () => undefined) } as never,
      { onClientInstalled: jest.fn(async () => undefined) } as never,
    );
    const res = await svc.handleInstall({ code: 'C', referer: 'https://acme.amocrm.ru/' });
    expect(res.subdomain).toBe('acme');
  });

  it('без code → ошибка', async () => {
    const svc = new OauthService(httpClient(), {} as never, {} as never, {} as never, {} as never);
    await expect(svc.handleInstall({ referer: 'demo.amocrm.ru' })).rejects.toThrow();
  });
});
