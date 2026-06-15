/**
 * Нормализация email (§6.1): trim + lowercase.
 * Опционально (gmailAliases) для gmail/googlemail — убрать точки и +alias в local-part.
 */
export function normalizeEmail(
  raw: string | null | undefined,
  opts: { gmailAliases?: boolean } = {},
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null; // нет local или domain
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return null;

  if (opts.gmailAliases && (domain === 'gmail.com' || domain === 'googlemail.com')) {
    local = local.split('+')[0].replace(/\./g, '');
    if (!local) return null;
  }
  return `${local}@${domain}`;
}
