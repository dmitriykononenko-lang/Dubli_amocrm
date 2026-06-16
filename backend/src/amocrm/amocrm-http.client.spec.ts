import { MockAgent, setGlobalDispatcher } from 'undici';
import { AmocrmHttpClient } from './amocrm-http.client';

// Юнит-тест мутаций клиента (PATCH/DELETE) без сети: amoCRM замокан через undici.
describe('AmocrmHttpClient mutations', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  function client(): AmocrmHttpClient {
    return new AmocrmHttpClient({ rateLimitRps: 1000 } as never);
  }

  it('apiPatch отправляет тело и парсит JSON-ответ', async () => {
    const pool = agent.get('https://demo.amocrm.ru');
    pool.intercept({ path: '/api/v4/contacts/100', method: 'PATCH' }).reply(200, { id: 100 });
    const res = await client().apiPatch('demo', 'k', '/api/v4/contacts/100', 'AT', { name: 'X' });
    expect(res).toEqual({ id: 100 });
  });

  it('apiDelete переносит пустое тело ответа в undefined', async () => {
    const pool = agent.get('https://demo.amocrm.ru');
    pool.intercept({ path: '/api/v4/contacts/100', method: 'DELETE' }).reply(204, '');
    const res = await client().apiDelete('demo', 'k', '/api/v4/contacts/100', 'AT');
    expect(res).toBeUndefined();
  });

  it('apiPost (link) отправляет массив связей', async () => {
    const pool = agent.get('https://demo.amocrm.ru');
    pool
      .intercept({ path: '/api/v4/contacts/100/link', method: 'POST' })
      .reply(200, { _embedded: {} });
    const res = await client().apiPost('demo', 'k', '/api/v4/contacts/100/link', 'AT', [
      { to_entity_id: 7, to_entity_type: 'leads' },
    ]);
    expect(res).toEqual({ _embedded: {} });
  });
});
