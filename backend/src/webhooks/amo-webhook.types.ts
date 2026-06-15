import type { EntityType } from '../common/db/database.types';
import type { RawAmoEntity } from '../entities/field-extractor';

export type WebhookOp = 'add' | 'update' | 'delete';

export interface WebhookEvent {
  entityType: EntityType;
  op: WebhookOp;
  amoId: string;
  raw: RawAmoEntity;
}

export interface ParsedWebhook {
  accountId: string | null;
  subdomain: string | null;
  events: WebhookEvent[];
}
