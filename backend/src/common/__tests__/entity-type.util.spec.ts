import { toPlural, toSingular, isCompany } from '../entity-type.util';
import { parseEntityTypeParam } from '../request-params';

describe('entity-type util — покупатели (customer)', () => {
  it('toPlural/toSingular round-trip для customer', () => {
    expect(toPlural('customer')).toBe('customers');
    expect(toSingular('customers')).toBe('customer');
  });

  it('customer нормализуется как контакт (не компания — без вырезания ОПФ)', () => {
    expect(isCompany('customer')).toBe(false);
  });

  it('parseEntityTypeParam принимает customer (ед.) и customers (мн.)', () => {
    expect(parseEntityTypeParam('customer')).toBe('customer');
    expect(parseEntityTypeParam('customers')).toBe('customer');
    expect(parseEntityTypeParam('CUSTOMER')).toBe('customer');
  });

  it('прочие сущности не сломаны', () => {
    expect(parseEntityTypeParam('lead')).toBe('lead');
    expect(parseEntityTypeParam('companies')).toBe('company');
    expect(parseEntityTypeParam('нечто')).toBeNull();
  });
});
