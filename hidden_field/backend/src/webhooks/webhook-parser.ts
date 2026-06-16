import { toSingular } from '../common/entity-type.util';
import type { ParsedWebhook, WebhookEvent, WebhookOp } from './amo-webhook.types';

const PLURALS = ['contacts', 'companies', 'leads'] as const;
const OPS: WebhookOp[] = ['add', 'update', 'delete'];

/**
 * Разбор тела вебхука amoCRM (form-urlencoded → вложенный объект, напр.
 * contacts[update][0][id]) в плоский список событий.
 */
export function parseWebhook(body: any): ParsedWebhook {
  const account = body?.account ?? {};
  const accountId = account?.id != null ? String(account.id) : null;
  const subdomain = account?.subdomain != null ? String(account.subdomain) : null;

  const events: WebhookEvent[] = [];
  for (const plural of PLURALS) {
    const group = body?.[plural];
    if (!group || typeof group !== 'object') continue;
    const entityType = toSingular(plural);
    if (!entityType) continue;
    for (const op of OPS) {
      const arr = group[op];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || item.id == null) continue;
        events.push({ entityType, op, amoId: String(item.id), raw: item });
      }
    }
  }
  return { accountId, subdomain, events };
}
