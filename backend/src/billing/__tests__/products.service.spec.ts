import { BadRequestException } from '@nestjs/common';
import { ProductsService } from '../products.service';
import type { SubscriptionsRepository } from '../subscriptions.repository';
import type { AppConfigService } from '../../config/app-config.service';

function make(product?: Record<string, unknown> | null) {
  const repo = {
    findProduct: jest.fn().mockResolvedValue(product ?? undefined),
  } as unknown as SubscriptionsRepository;
  const config = { billingPricePerUser: 399, billingMinUsers: 5 } as unknown as AppConfigService;
  return { svc: new ProductsService(repo, config), repo };
}

describe('ProductsService.pricing — эффективный тариф продукта', () => {
  it("'dubli' без переопределения = глобальный env (как раньше)", async () => {
    const { svc, repo } = make();
    await expect(svc.pricing('dubli')).resolves.toEqual({ pricePerUser: 399, minUsers: 5 });
    // Для 'dubli' в products даже не ходим — тариф всегда глобальный.
    expect(repo.findProduct).not.toHaveBeenCalled();
  });

  it('пустой продукт → фолбэк на дефолт (dubli) и глобальный env', async () => {
    const { svc } = make();
    await expect(svc.pricing()).resolves.toEqual({ pricePerUser: 399, minUsers: 5 });
  });

  it('продукт со своим price_per_user считает по нему', async () => {
    const { svc } = make({ code: 'raspredelenie', price_per_user: '590.00', min_users: 3 });
    await expect(svc.pricing('raspredelenie')).resolves.toEqual({ pricePerUser: 590, minUsers: 3 });
  });

  it('null-поля продукта → фолбэк на глобальный env по каждому полю', async () => {
    const { svc } = make({ code: 'x', price_per_user: null, min_users: null });
    await expect(svc.pricing('x')).resolves.toEqual({ pricePerUser: 399, minUsers: 5 });
  });

  it('неизвестный продукт → глобальный env', async () => {
    const { svc } = make(null);
    await expect(svc.pricing('missing')).resolves.toEqual({ pricePerUser: 399, minUsers: 5 });
  });
});

describe('ProductsService.quote — котировка по тарифу продукта', () => {
  it("'dubli': 5 польз. × 6 мес = 11 970 ₽ (глобальный тариф)", async () => {
    const { svc } = make();
    const q = await svc.quote(5, 6, 'dubli');
    expect(q.sum).toBe(11970);
    expect(q.pricePerUser).toBe(399);
  });

  it('продукт со своим тарифом: 5 польз. × 6 мес × 590 ₽ = 17 700 ₽', async () => {
    const { svc } = make({ code: 'raspredelenie', price_per_user: '590.00', min_users: 3 });
    const q = await svc.quote(5, 6, 'raspredelenie');
    expect(q.pricePerUser).toBe(590);
    expect(q.sum).toBe(590 * 5 * 6);
  });

  it('минимум пользователей берётся из тарифа продукта', async () => {
    const { svc } = make({ code: 'raspredelenie', price_per_user: '590.00', min_users: 8 });
    const q = await svc.quote(2, 6, 'raspredelenie');
    expect(q.users).toBe(8);
  });
});

describe('ProductsService.normalizeCode — платёжный код из внешнего ввода', () => {
  it('trim + lower-case; пусто/null → dubli', () => {
    expect(ProductsService.normalizeCode('  Raspredelenie ')).toBe('raspredelenie');
    expect(ProductsService.normalizeCode('')).toBe('dubli');
    expect(ProductsService.normalizeCode(null)).toBe('dubli');
    expect(ProductsService.normalizeCode(undefined)).toBe('dubli');
  });
});

describe('ProductsService.resolve — продукт для checkout/счёта', () => {
  it("'dubli' валиден даже без строки в реестре", async () => {
    const { svc } = make(null);
    await expect(svc.resolve()).resolves.toEqual({
      code: 'dubli',
      name: 'Дубли',
      pipelineId: null,
    });
  });

  it("'dubli' со строкой в реестре берёт имя и воронку оттуда", async () => {
    const { svc } = make({ code: 'dubli', name: 'Дубли', pipeline_id: '11130042', enabled: true });
    await expect(svc.resolve('dubli')).resolves.toEqual({
      code: 'dubli',
      name: 'Дубли',
      pipelineId: 11130042,
    });
  });

  it('продукт из реестра → код, имя, воронка (BIGINT приходит строкой)', async () => {
    const { svc } = make({
      code: 'raspredelenie',
      name: 'Распределение',
      pipeline_id: '22200000',
      enabled: true,
    });
    await expect(svc.resolve('Raspredelenie')).resolves.toEqual({
      code: 'raspredelenie',
      name: 'Распределение',
      pipelineId: 22200000,
    });
  });

  it('воронка не задана → pipelineId null (фолбэк на глобальную в BillingService)', async () => {
    const { svc } = make({ code: 'x', name: 'X', pipeline_id: null, enabled: true });
    await expect(svc.resolve('x')).resolves.toEqual({ code: 'x', name: 'X', pipelineId: null });
  });

  it('неизвестный продукт → 400', async () => {
    const { svc } = make(null);
    await expect(svc.resolve('missing')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('выключенный продукт → 400', async () => {
    const { svc } = make({ code: 'old', name: 'Old', enabled: false });
    await expect(svc.resolve('old')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductsService.resolveLenient — продукт из metadata проведённого платежа', () => {
  it('известный продукт → known:true с воронкой', async () => {
    const { svc } = make({
      code: 'raspredelenie',
      name: 'Распределение',
      pipeline_id: 22200000,
      enabled: true,
    });
    await expect(svc.resolveLenient('raspredelenie')).resolves.toEqual({
      code: 'raspredelenie',
      name: 'Распределение',
      pipelineId: 22200000,
      known: true,
    });
  });

  it("без кода → 'dubli', known:true (платежи до хаба)", async () => {
    const { svc } = make(null);
    await expect(svc.resolveLenient(undefined)).resolves.toEqual({
      code: 'dubli',
      name: 'Дубли',
      pipelineId: null,
      known: true,
    });
  });

  it('неизвестный код → не бросает, known:false (платёж учитывается, сделку не трогаем)', async () => {
    const { svc } = make(null);
    await expect(svc.resolveLenient('typo')).resolves.toEqual({
      code: 'typo',
      name: 'typo',
      pipelineId: null,
      known: false,
    });
  });
});
