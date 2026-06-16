import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, FieldMode } from '../common/db/database.types';

export interface MatrixRow {
  user_id: string;
  field_id: string;
  mode: FieldMode;
}

@Injectable()
export class VisibilityRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Вся матрица аккаунта (для экрана настроек). */
  async findAll(accountId: string): Promise<MatrixRow[]> {
    requireAccountId(accountId);
    return this.db
      .selectFrom('visibility_matrix')
      .select(['user_id', 'field_id', 'mode'])
      .where('account_id', '=', accountId)
      .execute();
  }

  /** Режимы полей конкретного пользователя (для применения в карточке). */
  async findByUser(
    accountId: string,
    userId: string,
  ): Promise<Array<{ field_id: string; mode: FieldMode }>> {
    requireAccountId(accountId);
    return this.db
      .selectFrom('visibility_matrix')
      .select(['field_id', 'mode'])
      .where('account_id', '=', accountId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Полная замена матрицы аккаунта (сохранение из экрана настроек) — атомарно. */
  async replaceAll(accountId: string, rows: MatrixRow[]): Promise<void> {
    requireAccountId(accountId);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('visibility_matrix').where('account_id', '=', accountId).execute();
      if (rows.length === 0) return;
      await trx
        .insertInto('visibility_matrix')
        .values(
          rows.map((r) => ({
            account_id: accountId,
            user_id: r.user_id,
            field_id: r.field_id,
            mode: r.mode,
            updated_at: new Date(),
          })),
        )
        .execute();
    });
  }
}
