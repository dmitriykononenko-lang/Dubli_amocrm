import { VisibilityService } from '../visibility.service';
import type { VisibilityRepository, MatrixRow, FunnelRow } from '../visibility.repository';
import type { AmocrmService } from '../../amocrm/amocrm.service';
import type { AuditService } from '../../common/audit/audit.service';

// Юнит-тест чистой логики сервиса: трансформация матрицы/воронок и парсинг сохранения.
// Репозиторий/amocrm/audit — лёгкие моки, БД не нужна.
function makeService(
  rows: MatrixRow[] = [],
  amocrm: Partial<AmocrmService> = {},
  funnels: FunnelRow[] = [],
) {
  let savedMatrix: MatrixRow[] | null = null;
  let savedFunnels: FunnelRow[] | null = null;
  const repo = {
    findAll: async () => rows,
    findByUser: async (_a: string, userId: string) =>
      rows.filter((r) => r.user_id === userId).map((r) => ({ field_id: r.field_id, mode: r.mode })),
    replaceAll: async (_a: string, r: MatrixRow[]) => {
      savedMatrix = r;
    },
    findFunnels: async () => funnels,
    replaceFunnels: async (_a: string, r: FunnelRow[]) => {
      savedFunnels = r;
    },
  } as unknown as VisibilityRepository;
  const audit = { log: async () => undefined } as unknown as AuditService;
  const service = new VisibilityService(repo, amocrm as AmocrmService, audit);
  return { service, getSavedMatrix: () => savedMatrix, getSavedFunnels: () => savedFunnels };
}

describe('VisibilityService', () => {
  it('getConfigForUser → rules в формате resolveMode, без режима O', async () => {
    const { service } = makeService([
      { user_id: '500', field_id: '111', mode: 'S' },
      { user_id: '500', field_id: '222', mode: '*' },
      { user_id: '501', field_id: '333', mode: 'B' },
    ]);
    const cfg = await service.getConfigForUser('1', '500');
    expect(cfg).toEqual({
      rules: { '111': { '*': { '*': 'S' } }, '222': { '*': { '*': '*' } } },
      funnels: {},
    });
  });

  it('getConfigForUser отдаёт funnels аккаунта (для режима V) и сохраняет V в rules', async () => {
    const { service } = makeService([{ user_id: '500', field_id: '111', mode: 'V' }], {}, [
      { pipeline_id: '7', field_id: '111', mode: 'S' },
      { pipeline_id: '7', field_id: '222', mode: 'B' },
    ]);
    const cfg = await service.getConfigForUser('1', '500');
    expect(cfg.rules).toEqual({ '111': { '*': { '*': 'V' } } });
    expect(cfg.funnels).toEqual({ '7': { '111': 'S', '222': 'B' } });
  });

  it('getConfigForUser требует user_id', async () => {
    const { service } = makeService();
    await expect(service.getConfigForUser('1', '')).rejects.toThrow();
  });

  it('saveMatrix отбрасывает режим O и кривые ключи, парсит field:user', async () => {
    const { service, getSavedMatrix } = makeService();
    const res = await service.saveMatrix('1', {
      '111:500': 'S',
      '222:500': 'O', // по умолчанию — не храним
      '333:501': '*',
      bad: 'B', // нет ':'
      '444:abc': 'B', // user_id не число
      '555:600': 'X', // невалидный режим
    });
    expect(res.saved).toBe(2);
    expect(getSavedMatrix()).toEqual([
      { field_id: '111', user_id: '500', mode: 'S' },
      { field_id: '333', user_id: '501', mode: '*' },
    ]);
  });

  it('saveFunnels парсит pipeline:field, допускает только S/*/B (без O и V)', async () => {
    const { service, getSavedFunnels } = makeService();
    const res = await service.saveFunnels('1', {
      '7:111': 'S',
      '7:sys_lead_price': 'B',
      '7:222': 'O', // O не хранится на воронке
      '7:333': 'V', // V на воронке недопустим
      'x:444': 'S', // pipeline не число
      '7:': 'S', // пустой field
    });
    expect(res.saved).toBe(2);
    expect(getSavedFunnels()).toEqual([
      { pipeline_id: '7', field_id: '111', mode: 'S' },
      { pipeline_id: '7', field_id: 'sys_lead_price', mode: 'B' },
    ]);
  });

  it('saveFunnels требует объект', async () => {
    const { service } = makeService();
    await expect(service.saveFunnels('1', null)).rejects.toThrow();
  });

  it('getMeta добавляет системные поля, сливает с кастомными и отдаёт funnels', async () => {
    const amocrm: Partial<AmocrmService> = {
      getCustomFields: async (_a, entity) =>
        entity === 'lead' ? [{ id: 111, name: 'Источник' }] : [],
      getUsers: async () => [{ id: 500, name: 'Менеджер' }],
      getPipelines: async () => [{ id: 7, name: 'Продажи' }],
    };
    const { service } = makeService(
      [{ user_id: '500', field_id: 'sys_lead_price', mode: 'B' }],
      amocrm,
      [{ pipeline_id: '7', field_id: '111', mode: 'S' }],
    );
    const meta = await service.getMeta('1');

    expect(meta.fields).toContainEqual({
      id: 'sys_lead_price',
      name: 'Бюджет',
      entity: 'lead',
      system: true,
    });
    expect(meta.fields).toContainEqual({ id: '111', name: 'Источник', entity: 'lead' });
    expect(meta.users).toEqual([{ id: '500', name: 'Менеджер' }]);
    expect(meta.matrix['sys_lead_price:500']).toBe('B');
    expect(meta.funnels).toEqual({ '7': { '111': 'S' } });
  });
});
