import { VisibilityService } from '../visibility.service';
import type { VisibilityRepository, MatrixRow } from '../visibility.repository';
import type { AmocrmService } from '../../amocrm/amocrm.service';
import type { AuditService } from '../../common/audit/audit.service';

// Юнит-тест чистой логики сервиса: трансформация матрицы в конфиг и парсинг сохранения.
// Репозиторий/amocrm/audit — лёгкие моки, БД не нужна.
function makeService(rows: MatrixRow[] = []) {
  let saved: MatrixRow[] | null = null;
  const repo = {
    findAll: async () => rows,
    findByUser: async (_a: string, userId: string) =>
      rows.filter((r) => r.user_id === userId).map((r) => ({ field_id: r.field_id, mode: r.mode })),
    replaceAll: async (_a: string, r: MatrixRow[]) => {
      saved = r;
    },
  } as unknown as VisibilityRepository;
  const amocrm = {} as AmocrmService;
  const audit = { log: async () => undefined } as unknown as AuditService;
  const service = new VisibilityService(repo, amocrm, audit);
  return { service, getSaved: () => saved };
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

  it('getConfigForUser требует user_id', async () => {
    const { service } = makeService();
    await expect(service.getConfigForUser('1', '')).rejects.toThrow();
  });

  it('saveMatrix отбрасывает режим O и кривые ключи, парсит field:user', async () => {
    const { service, getSaved } = makeService();
    const res = await service.saveMatrix('1', {
      '111:500': 'S',
      '222:500': 'O', // по умолчанию — не храним
      '333:501': '*',
      bad: 'B', // нет ':'
      '444:abc': 'B', // user_id не число
      '555:600': 'X', // невалидный режим
    });
    expect(res.saved).toBe(2);
    expect(getSaved()).toEqual([
      { field_id: '111', user_id: '500', mode: 'S' },
      { field_id: '333', user_id: '501', mode: '*' },
    ]);
  });

  it('saveMatrix требует объект', async () => {
    const { service } = makeService();
    await expect(service.saveMatrix('1', null)).rejects.toThrow();
  });
});
