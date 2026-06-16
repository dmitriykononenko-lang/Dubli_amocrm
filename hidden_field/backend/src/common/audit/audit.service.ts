import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../db/kysely.tokens';
import type { AuditAction, DB } from '../db/database.types';

/** Аудит операций (§8). Сбой записи аудита не должен ронять основную операцию. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async log(params: {
    accountId?: string | null;
    actor?: string | null;
    action: AuditAction;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db
        .insertInto('audit_log')
        .values({
          account_id: params.accountId ?? null,
          actor: params.actor ?? 'system',
          action: params.action,
          meta: JSON.stringify(params.meta ?? {}),
        })
        .execute();
    } catch (e) {
      this.logger.error(`Не удалось записать audit_log: ${(e as Error).message}`);
    }
  }
}
