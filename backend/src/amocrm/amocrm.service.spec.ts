import { AmocrmService } from './amocrm.service';

// Юнит-тест парсинга листинга: http/tokens/accounts — моки.
describe('AmocrmService.listPage', () => {
  function setup(apiGet: jest.Mock) {
    const http = { apiGet };
    const tokens = { getValidAccessToken: jest.fn(async () => 'AT') };
    const accounts = { findById: jest.fn(async () => ({ account_id: '1', subdomain: 'demo' })) };
    const config = { vendorAmocrmToken: undefined, vendorAmocrmSubdomain: undefined, vendorAmocrmAccountId: undefined };
    return new AmocrmService(http as never, tokens as never, accounts as never, config as never);
  }

  it('первая страница: запрос с limit, парсинг _embedded и _links.next в курсор', async () => {
    const apiGet = jest.fn(async () => ({
      _embedded: { contacts: [{ id: 1 }, { id: 2 }] },
      _links: { next: { href: 'https://demo.amocrm.ru/api/v4/contacts?page=2&limit=250' } },
    }));
    const page = await setup(apiGet).listPage('1', 'contact', null);
    expect(page.items).toHaveLength(2);
    expect(page.nextPath).toBe('/api/v4/contacts?page=2&limit=250');
    expect(apiGet).toHaveBeenCalledWith('demo', '1', '/api/v4/contacts?limit=250', 'AT');
  });

  it('переданный курсор используется как путь; без _links.next → nextPath null', async () => {
    const apiGet = jest.fn(async () => ({ _embedded: { contacts: [] } }));
    const page = await setup(apiGet).listPage('1', 'contact', '/api/v4/contacts?page=9');
    expect(page.items).toEqual([]);
    expect(page.nextPath).toBeNull();
    expect(apiGet).toHaveBeenCalledWith('demo', '1', '/api/v4/contacts?page=9', 'AT');
  });

  it('пустой ответ (204 → undefined) → пустая страница', async () => {
    const page = await setup(jest.fn(async () => undefined)).listPage('1', 'company', null);
    expect(page).toEqual({ items: [], nextPath: null });
  });
});
