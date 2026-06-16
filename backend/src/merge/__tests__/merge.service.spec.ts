import { MergeService } from '../merge.service';

const ACC = '777';

function setup() {
  const amocrm = {
    getById: jest.fn(),
    update: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
    getLinks: jest.fn(async () => [] as unknown[]),
    link: jest.fn(async () => undefined),
    create: jest.fn(async () => '900'),
  };
  const merges = {
    record: jest.fn(async (_input: unknown) => ({ mergeId: '55' })),
    findJournal: jest.fn(),
    findSnapshots: jest.fn(),
    markRolledBack: jest.fn(async () => undefined),
  };
  const entities = {
    indexEntity: jest.fn(async () => ({ entityId: '1', keyCount: 0 })),
    remove: jest.fn(async () => undefined),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new MergeService(
    amocrm as never,
    merges as never,
    entities as never,
    audit as never,
  );
  return { service, amocrm, merges, entities, audit };
}

const master = {
  id: 100,
  name: 'Мастер',
  custom_fields_values: [{ field_id: 1, values: [{ value: 'p' }] }],
};
const duplicate = {
  id: 200,
  name: 'Дубль',
  custom_fields_values: [{ field_id: 2, values: [{ value: 'e' }] }],
};

describe('MergeService.merge', () => {
  it('переносит поля/связи, удаляет дубль, пишет журнал и переиндексирует', async () => {
    const { service, amocrm, merges, entities, audit } = setup();
    amocrm.getById.mockImplementation(async (_acc, _type, id) =>
      id === '100' ? master : duplicate,
    );
    amocrm.getLinks.mockResolvedValue([{ to_entity_id: 7, to_entity_type: 'leads' }]);

    const res = await service.merge(ACC, {
      entityType: 'contact',
      masterAmoId: '100',
      duplicateAmoId: '200',
      authorUserId: '42',
    });

    // поле 2 дубля переносится на главную (gap-fill)
    expect(amocrm.update).toHaveBeenCalledWith(ACC, 'contact', '100', {
      custom_fields_values: [{ field_id: 2, values: [{ value: 'e' }] }],
    });
    // связи дубля переносятся на главную
    expect(amocrm.link).toHaveBeenCalledWith(ACC, 'contact', '100', [
      { to_entity_id: 7, to_entity_type: 'leads' },
    ]);
    // дубль удаляется
    expect(amocrm.remove).toHaveBeenCalledWith(ACC, 'contact', '200');
    // журнал + снимки обеих сущностей
    const recordArg = merges.record.mock.calls[0][0] as {
      mode: string;
      authorUserId: string;
      transferred: unknown;
      snapshots: Array<{ amoId: string }>;
    };
    expect(recordArg).toMatchObject({
      mode: 'manual',
      authorUserId: '42',
      transferred: { name: false, field_ids: [2], links: 1 },
    });
    expect(recordArg.snapshots.map((s) => s.amoId)).toEqual(['100', '200']);
    // локальный индекс: главная переиндексирована (с новым полем), дубль удалён
    expect(entities.indexEntity).toHaveBeenCalledWith(
      ACC,
      'contact',
      '100',
      expect.objectContaining({
        custom_fields_values: [
          { field_id: 1, values: [{ value: 'p' }] },
          { field_id: 2, values: [{ value: 'e' }] },
        ],
      }),
    );
    expect(entities.remove).toHaveBeenCalledWith(ACC, 'contact', '200');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'merge' }));
    expect(res).toEqual({
      mergeId: '55',
      master_amo_id: '100',
      duplicate_amo_id: '200',
      transferred: { name: false, field_ids: [2], links: 1 },
    });
  });

  it('не вызывает update, когда переносить поля не нужно', async () => {
    const { service, amocrm } = setup();
    amocrm.getById.mockResolvedValue(master); // оба «полных» — gap-fill пуст
    await service.merge(ACC, { entityType: 'contact', masterAmoId: '100', duplicateAmoId: '200' });
    expect(amocrm.update).not.toHaveBeenCalled();
    expect(amocrm.remove).toHaveBeenCalledWith(ACC, 'contact', '200');
  });

  it('master == duplicate → ошибка, без вызовов API', async () => {
    const { service, amocrm } = setup();
    await expect(
      service.merge(ACC, { entityType: 'contact', masterAmoId: '5', duplicateAmoId: '5' }),
    ).rejects.toThrow();
    expect(amocrm.getById).not.toHaveBeenCalled();
  });
});

describe('MergeService.rollback', () => {
  function journal(overrides = {}) {
    return {
      id: '55',
      account_id: ACC,
      entity_type: 'contact',
      master_amo_id: '100',
      duplicate_amo_id: '200',
      rolled_back_at: null,
      ...overrides,
    };
  }
  const snapshots = [
    {
      amo_id: '100',
      payload: {
        name: 'Мастер',
        custom_fields_values: [{ field_id: 1, values: [{ value: 'p' }] }],
      },
    },
    {
      amo_id: '200',
      payload: { name: 'Дубль', custom_fields_values: [{ field_id: 2, values: [{ value: 'e' }] }] },
    },
  ];

  it('возвращает поля главной, воссоздаёт дубль и отмечает откат', async () => {
    const { service, amocrm, merges, entities, audit } = setup();
    merges.findJournal.mockResolvedValue(journal());
    merges.findSnapshots.mockResolvedValue(snapshots);
    amocrm.create.mockResolvedValue('900');

    const res = await service.rollback(ACC, '55');

    expect(amocrm.update).toHaveBeenCalledWith(ACC, 'contact', '100', {
      name: 'Мастер',
      custom_fields_values: [{ field_id: 1, values: [{ value: 'p' }] }],
    });
    expect(amocrm.create).toHaveBeenCalledWith(ACC, 'contact', {
      name: 'Дубль',
      custom_fields_values: [{ field_id: 2, values: [{ value: 'e' }] }],
    });
    expect(merges.markRolledBack).toHaveBeenCalledWith(ACC, '55');
    expect(entities.indexEntity).toHaveBeenCalledWith(ACC, 'contact', '900', expect.any(Object));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollback' }));
    expect(res).toEqual({ mergeId: '55', master_amo_id: '100', restored_duplicate_amo_id: '900' });
  });

  it('повторный откат запрещён', async () => {
    const { service, merges } = setup();
    merges.findJournal.mockResolvedValue(journal({ rolled_back_at: new Date() }));
    await expect(service.rollback(ACC, '55')).rejects.toThrow();
  });

  it('неизвестное объединение → ошибка', async () => {
    const { service, merges } = setup();
    merges.findJournal.mockResolvedValue(undefined);
    await expect(service.rollback(ACC, '999')).rejects.toThrow();
  });
});
