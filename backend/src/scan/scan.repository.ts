import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, EntityType, ScanStatus } from '../common/db/database.types';

export interface ScanJob {
  id: string;
  account_id: string;
  entity_type: EntityType;
  status: ScanStatus;
  progress: number;
  total: number;
  cursor: string | null;
  params: Record<string, unknown>;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export interface ScanJobPatch {
  status?: ScanStatus;
  progress?: number;
  total?: number;
  cursor?: string | null;
  started_at?: Date | null;
  finished_at?: Date | null;
}

const SCAN_COLUMNS = [
  'id',
  'account_id',
  'entity_type',
  'status',
  'progress',
  'total',
  'cursor',
  'params',
  'started_at',
  'finished_at',
  'created_at',
] as const;

@Injectable()
export class ScanJobsRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async create(
    accountId: string,
    entityType: EntityType,
    params: Record<string, unknown>,
  ): Promise<ScanJob> {
    requireAccountId(accountId);
    const row = await this.db
      .insertInto('scan_jobs')
      .values({
        account_id: accountId,
        entity_type: entityType,
        status: 'queued',
        params: JSON.stringify(params),
      })
      .returning(SCAN_COLUMNS)
      .executeTakeFirstOrThrow();
    return this.normalize(row);
  }

  async findById(accountId: string, id: string): Promise<ScanJob | undefined> {
    requireAccountId(accountId);
    const row = await this.db
      .selectFrom('scan_jobs')
      .select(SCAN_COLUMNS)
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.normalize(row) : undefined;
  }

  async list(accountId: string): Promise<ScanJob[]> {
    requireAccountId(accountId);
    const rows = await this.db
      .selectFrom('scan_jobs')
      .select(SCAN_COLUMNS)
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => this.normalize(r));
  }

  /**
   * Следующая задача к обработке (системный вызов фонового процессора, без скоупа аккаунта —
   * account_id несёт сама задача). Старые задачи вперёд: запущенная раньше продолжается первой.
   */
  async findRunnable(): Promise<ScanJob | undefined> {
    const row = await this.db
      .selectFrom('scan_jobs')
      .select(SCAN_COLUMNS)
      .where('status', 'in', ['running', 'queued'])
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    return row ? this.normalize(row) : undefined;
  }

  /** Обновление прогресса/статуса по id (системный вызов процессора). */
  async update(id: string, patch: ScanJobPatch): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.progress !== undefined) set.progress = patch.progress;
    if (patch.total !== undefined) set.total = patch.total;
    if (patch.cursor !== undefined) set.cursor = patch.cursor;
    if (patch.started_at !== undefined) set.started_at = patch.started_at;
    if (patch.finished_at !== undefined) set.finished_at = patch.finished_at;
    if (Object.keys(set).length === 0) return;
    await this.db.updateTable('scan_jobs').set(set).where('id', '=', id).execute();
  }

  private normalize(
    row: Omit<ScanJob, 'params'> & { params: Record<string, unknown> | null },
  ): ScanJob {
    return { ...row, params: row.params ?? {} };
  }
}
