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

  const PRIVATE_CLIENT = {
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'https://example.com/oauth/callback',
  };
  const PUBLIC_CLIENT = {
    clientId: 'pub-cid',
    clientSecret: 'pub-secret',
    redirectUri: 'https://example.com/oauth/callback/public',
  };

  function httpClient(): AmocrmHttpClient {
    const config = {
      privateOauthClient: PRIVATE_CLIENT,
      amocrmClientId: 'cid',
      amocrmClientSecret: 'secret',
      amocrmRedirectUri: 'https://example.com/oauth/callback',
      rateLimitRps: 7,
    };
    return new AmocrmHttpClient(config as never);
  }

  function cfg(pub: { clientId: string } | null = null) {
    return {
      amocrmClientId: PRIVATE_CLIENT.clientId,
      privateOauthClient: PRIVATE_CLIENT,
      publicOauthClient: pub,
      knownOauthClient: (id: string) => {
        if (id === PRIVATE_CLIENT.clientId) return PRIVATE_CLIENT;
        if (pub && id === pub.clientId) return pub;
        return null;
      },
    };
  }
  const accountsMock = () => ({
    upsert: jest.fn(async () => undefined),
    getSettings: jest.fn(async () => ({})),
    updateSettings: jest.fn(async () => undefined),
  });

  it('обменивает code, получает account_id, сохраняет аккаунт и токены', async () => {
    const pool = agent.get('https://demo.amocrm.ru');
    pool.intercept({ path: '/oauth2/access_token', method: 'POST' }).reply(200, {
      token_type: 'Bearer',
      expires_in: 86400,
      access_token: 'AT',
      refresh_token: 'RT',
    });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 777 });

    const accounts = accountsMock();
    const tokens = { save: jest.fn(async () => undefined) };
    const audit = { log: jest.fn(async () => undefined) };
    const billing = { onClientInstalled: jest.fn(async () => undefined) };
    const svc = new OauthService(
      httpClient(),
      accounts as never,
      tokens as never,
      audit as never,
      billing as never,
      cfg() as never,
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
    // приватная установка → запомнили приватный client_id
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '777',
      expect.objectContaining({ oauth_client_id: 'cid' }),
    );
    expect(audit.log).toHaveBeenCalled();
  });

  it('публичная установка (/callback/public) использует публичный client и запоминает его', async () => {
    const pool = agent.get('https://mkt.amocrm.ru');
    pool
      .intercept({ path: '/oauth2/access_token', method: 'POST' })
      .reply(200, { token_type: 'Bearer', expires_in: 86400, access_token: 'AT', refresh_token: 'RT' });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 42 });

    const accounts = accountsMock();
    const svc = new OauthService(
      httpClient(),
      accounts as never,
      { save: jest.fn(async () => undefined) } as never,
      { log: jest.fn(async () => undefined) } as never,
      { onClientInstalled: jest.fn(async () => undefined) } as never,
      cfg(PUBLIC_CLIENT) as never,
    );
    await svc.handleInstall({ code: 'C', referer: 'mkt.amocrm.ru' }, 'public');
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({ oauth_client_id: 'pub-cid' }),
    );
  });

  it('выбирает клиента по client_id из query (публичный) даже на общем redirect', async () => {
    const pool = agent.get('https://q.amocrm.ru');
    pool
      .intercept({ path: '/oauth2/access_token', method: 'POST' })
      .reply(200, { token_type: 'Bearer', expires_in: 86400, access_token: 'AT', refresh_token: 'RT' });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 55 });

    const accounts = accountsMock();
    const svc = new OauthService(
      httpClient(),
      accounts as never,
      { save: jest.fn(async () => undefined) } as never,
      { log: jest.fn(async () => undefined) } as never,
      { onClientInstalled: jest.fn(async () => undefined) } as never,
      cfg(PUBLIC_CLIENT) as never,
    );
    // variant по умолчанию private, но client_id в query = публичный → берём публичный
    await svc.handleInstall({ code: 'C', referer: 'q.amocrm.ru', client_id: 'pub-cid' });
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '55',
      expect.objectContaining({ oauth_client_id: 'pub-cid' }),
    );
  });

  it('неизвестный client_id из query → ошибка', async () => {
    const svc = new OauthService(
      httpClient(),
      accountsMock() as never,
      { save: jest.fn() } as never,
      { log: jest.fn() } as never,
      { onClientInstalled: jest.fn() } as never,
      cfg(PUBLIC_CLIENT) as never,
    );
    await expect(
      svc.handleInstall({ code: 'C', referer: 'x.amocrm.ru', client_id: 'stranger' }),
    ).rejects.toThrow();
  });

  it('публичная установка без настроенного PUBLIC_* → ошибка', async () => {
    const svc = new OauthService(
      httpClient(),
      accountsMock() as never,
      { save: jest.fn() } as never,
      { log: jest.fn() } as never,
      { onClientInstalled: jest.fn() } as never,
      cfg(null) as never,
    );
    await expect(svc.handleInstall({ code: 'C', referer: 'x.amocrm.ru' }, 'public')).rejects.toThrow();
  });

  it('извлекает subdomain из полного URL referer', async () => {
    const pool = agent.get('https://acme.amocrm.ru');
    pool
      .intercept({ path: '/oauth2/access_token', method: 'POST' })
      .reply(200, { token_type: 'Bearer', expires_in: 1, access_token: 'a', refresh_token: 'r' });
    pool.intercept({ path: '/api/v4/account', method: 'GET' }).reply(200, { id: 1 });

    const svc = new OauthService(
      httpClient(),
      accountsMock() as never,
      { save: jest.fn(async () => undefined) } as never,
      { log: jest.fn(async () => undefined) } as never,
      { onClientInstalled: jest.fn(async () => undefined) } as never,
      cfg() as never,
    );
    const res = await svc.handleInstall({ code: 'C', referer: 'https://acme.amocrm.ru/' });
    expect(res.subdomain).toBe('acme');
  });

  it('без code → ошибка', async () => {
    const svc = new OauthService(
      httpClient(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      cfg() as never,
    );
    await expect(svc.handleInstall({ referer: 'demo.amocrm.ru' })).rejects.toThrow();
  });
});
