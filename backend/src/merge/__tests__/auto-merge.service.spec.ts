import { AutoMergeService } from '../auto-merge.service';

function setup() {
  const duplicates = { findAutoMergeTarget: jest.fn() };
  const merge = { merge: jest.fn(async () => ({ mergeId: '77' })) };
  const service = new AutoMergeService(duplicates as never, merge as never);
  return { service, duplicates, merge };
}

describe('AutoMergeService.tryForEntity', () => {
  it('нет пары → merged:false, merge не вызывается', async () => {
    const { service, duplicates, merge } = setup();
    duplicates.findAutoMergeTarget.mockResolvedValue(null);
    expect(await service.tryForEntity('777', 'contact', '500')).toEqual({ merged: false });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('есть пара → merge с режимом auto', async () => {
    const { service, duplicates, merge } = setup();
    duplicates.findAutoMergeTarget.mockResolvedValue({ masterAmoId: '500', duplicateAmoId: '501' });
    const r = await service.tryForEntity('777', 'contact', '501');
    expect(merge.merge).toHaveBeenCalledWith('777', {
      entityType: 'contact',
      masterAmoId: '500',
      duplicateAmoId: '501',
      mode: 'auto',
      authorUserId: null,
    });
    expect(r).toMatchObject({ merged: true, mergeId: '77' });
  });

  it('ошибка merge не пробрасывается (best-effort)', async () => {
    const { service, duplicates, merge } = setup();
    duplicates.findAutoMergeTarget.mockResolvedValue({ masterAmoId: '500', duplicateAmoId: '501' });
    merge.merge.mockRejectedValue(new Error('boom'));
    expect(await service.tryForEntity('777', 'contact', '501')).toEqual({ merged: false });
  });
});
