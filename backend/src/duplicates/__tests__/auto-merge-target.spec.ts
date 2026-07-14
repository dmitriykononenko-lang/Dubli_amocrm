import { DuplicatesService } from '../duplicates.service';
import type { KeyType } from '../../common/db/database.types';

function setup() {
  const repo = {
    findEntityId: jest.fn(),
    findCandidateMatches: jest.fn(async () => [] as unknown[]),
  };
  const rules = { findEnabled: jest.fn(async () => [] as unknown[]) };
  const service = new DuplicatesService(repo as never, rules as never);
  return { service, repo, rules };
}

function match(amoId: string, keyType: KeyType) {
  return { entity_id: 'x', amo_id: amoId, key_fields: {}, key_type: keyType, key_norm: 'n' };
}
function autoRule(over: Record<string, unknown> = {}) {
  return {
    id: '1',
    name: 'auto',
    fields: [{ key_type: 'phone' }],
    operator: 'OR',
    auto_merge: true,
    ...over,
  };
}

describe('DuplicatesService.findAutoMergeTarget', () => {
  it('нет сущности в индексе → null', async () => {
    const { service, repo } = setup();
    repo.findEntityId.mockResolvedValue(undefined);
    expect(await service.findAutoMergeTarget('777', 'contact', '500')).toBeNull();
  });

  it('нет правил с auto_merge → null', async () => {
    const { service, repo, rules } = setup();
    repo.findEntityId.mockResolvedValue('10');
    repo.findCandidateMatches.mockResolvedValue([match('501', 'phone')]);
    rules.findEnabled.mockResolvedValue([autoRule({ auto_merge: false })]);
    expect(await service.findAutoMergeTarget('777', 'contact', '500')).toBeNull();
  });

  it('один кандидат под auto_merge → пара (главная — меньший amo_id)', async () => {
    const { service, repo, rules } = setup();
    repo.findEntityId.mockResolvedValue('10');
    rules.findEnabled.mockResolvedValue([autoRule()]);

    repo.findCandidateMatches.mockResolvedValue([match('501', 'phone')]);
    expect(await service.findAutoMergeTarget('777', 'contact', '500')).toEqual({
      masterAmoId: '500',
      duplicateAmoId: '501',
    });

    // текущая (600) новее кандидата (501) → главная = 501
    repo.findCandidateMatches.mockResolvedValue([match('501', 'phone')]);
    expect(await service.findAutoMergeTarget('777', 'contact', '600')).toEqual({
      masterAmoId: '501',
      duplicateAmoId: '600',
    });
  });

  it('несколько кандидатов под auto_merge → null (неоднозначно)', async () => {
    const { service, repo, rules } = setup();
    repo.findEntityId.mockResolvedValue('10');
    repo.findCandidateMatches.mockResolvedValue([match('501', 'phone'), match('502', 'phone')]);
    rules.findEnabled.mockResolvedValue([autoRule()]);
    expect(await service.findAutoMergeTarget('777', 'contact', '500')).toBeNull();
  });

  it('правило AND не выполнено (совпал только один ключ) → null', async () => {
    const { service, repo, rules } = setup();
    repo.findEntityId.mockResolvedValue('10');
    repo.findCandidateMatches.mockResolvedValue([match('501', 'phone')]);
    rules.findEnabled.mockResolvedValue([
      autoRule({ operator: 'AND', fields: [{ key_type: 'phone' }, { key_type: 'email' }] }),
    ]);
    expect(await service.findAutoMergeTarget('777', 'contact', '500')).toBeNull();
  });
});
