import { ScanService } from '../scan.service';
import type { ScanJob } from '../scan.repository';
import type { ScanStatus } from '../../common/db/database.types';

function job(status: ScanStatus, over: Partial<ScanJob> = {}): ScanJob {
  return {
    id: '9',
    account_id: '777',
    entity_type: 'contact',
    status,
    progress: 0,
    total: 0,
    cursor: null,
    params: {},
    started_at: null,
    finished_at: null,
    created_at: new Date(),
    ...over,
  };
}

function setup() {
  const repo = {
    create: jest.fn(async () => job('queued')),
    findById: jest.fn(),
    list: jest.fn(async () => []),
    findRunnable: jest.fn(),
    update: jest.fn(async () => undefined),
  };
  const amocrm = { listPage: jest.fn() };
  const entities = {
    indexEntity: jest.fn(async () => ({ entityId: '1', keyCount: 0 })),
    remove: jest.fn(),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new ScanService(
    repo as never,
    amocrm as never,
    entities as never,
    audit as never,
  );
  return { service, repo, amocrm, entities, audit };
}

describe('ScanService.processOnce', () => {
  it('нет активных задач → idle', async () => {
    const { service, repo } = setup();
    repo.findRunnable.mockResolvedValue(undefined);
    expect(await service.processOnce()).toEqual({ idle: true, processed: 0 });
  });

  it('queued → running: индексирует страницу, сохраняет курсор', async () => {
    const { service, repo, amocrm, entities } = setup();
    repo.findRunnable.mockResolvedValue(job('queued'));
    amocrm.listPage.mockResolvedValue({
      items: [{ id: 1 }, { id: 2 }],
      nextPath: '/api/v4/contacts?page=2',
    });

    const r = await service.processOnce();

    expect(repo.update).toHaveBeenCalledWith('9', {
      status: 'running',
      started_at: expect.any(Date),
    });
    expect(entities.indexEntity).toHaveBeenCalledTimes(2);
    expect(repo.update).toHaveBeenCalledWith('9', {
      status: 'running',
      progress: 2,
      cursor: '/api/v4/contacts?page=2',
    });
    expect(r).toMatchObject({ idle: false, status: 'running', processed: 2 });
  });

  it('последняя страница (nextPath=null) → done с total и finished_at', async () => {
    const { service, repo, amocrm, audit } = setup();
    repo.findRunnable.mockResolvedValue(
      job('running', { progress: 5, cursor: '/api/v4/contacts?page=3' }),
    );
    amocrm.listPage.mockResolvedValue({ items: [{ id: 7 }], nextPath: null });

    const r = await service.processOnce();

    expect(amocrm.listPage).toHaveBeenCalledWith('777', 'contact', '/api/v4/contacts?page=3');
    expect(repo.update).toHaveBeenCalledWith('9', {
      status: 'done',
      progress: 6,
      total: 6,
      cursor: null,
      finished_at: expect.any(Date),
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'scan' }));
    expect(r.status).toBe('done');
  });

  it('пропускает элементы без id', async () => {
    const { service, repo, amocrm, entities } = setup();
    repo.findRunnable.mockResolvedValue(job('running'));
    amocrm.listPage.mockResolvedValue({ items: [{ id: 1 }, {}, { id: 3 }], nextPath: null });
    const r = await service.processOnce();
    expect(entities.indexEntity).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(2);
  });

  it('ошибка amoCRM → статус error', async () => {
    const { service, repo, amocrm } = setup();
    repo.findRunnable.mockResolvedValue(job('running'));
    amocrm.listPage.mockRejectedValue(new Error('boom'));
    const r = await service.processOnce();
    expect(repo.update).toHaveBeenCalledWith('9', {
      status: 'error',
      finished_at: expect.any(Date),
    });
    expect(r.status).toBe('error');
  });
});

describe('ScanService очередь и управление', () => {
  it('enqueue создаёт задачу и пишет аудит; DTO без account_id', async () => {
    const { service, repo, audit } = setup();
    repo.create.mockResolvedValue(job('queued'));
    const dto = await service.enqueue('777', 'contact');
    expect(repo.create).toHaveBeenCalledWith('777', 'contact', {});
    expect(audit.log).toHaveBeenCalled();
    expect(dto).toMatchObject({ id: '9', entity_type: 'contact', status: 'queued' });
    const asRec = dto as unknown as Record<string, unknown>;
    expect(asRec.account_id).toBeUndefined();
    expect(asRec.cursor).toBeUndefined();
  });

  it('pause активную → paused; неактивную → ошибка', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(job('running'));
    await service.pause('777', '9');
    expect(repo.update).toHaveBeenCalledWith('9', { status: 'paused' });

    repo.findById.mockResolvedValue(job('done'));
    await expect(service.pause('777', '9')).rejects.toThrow();
  });

  it('resume только приостановленную', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(job('paused'));
    await service.resume('777', '9');
    expect(repo.update).toHaveBeenCalledWith('9', { status: 'queued' });

    repo.findById.mockResolvedValue(job('running'));
    await expect(service.resume('777', '9')).rejects.toThrow();
  });

  it('get несуществующей → ошибка', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(undefined);
    await expect(service.get('777', '9')).rejects.toThrow();
  });
});
