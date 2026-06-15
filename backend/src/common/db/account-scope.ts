/**
 * Изоляция данных по account_id (152-ФЗ, §8).
 * Все репозитории обязаны фильтровать запросы по account_id и вызывать этот guard,
 * чтобы исключить случайные запросы без скоупа аккаунта.
 */
export function requireAccountId(accountId: string | null | undefined): string {
  if (accountId === null || accountId === undefined || accountId === '') {
    throw new Error('account_id обязателен для всех запросов (изоляция по аккаунту)');
  }
  return accountId;
}
