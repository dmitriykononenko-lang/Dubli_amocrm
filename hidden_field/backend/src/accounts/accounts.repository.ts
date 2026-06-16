import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { AccountSettings, DB } from '../common/db/database.types';

@Injectable()
export class AccountsRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async upsert(input: { accountId: string; subdomain: string; status?: string }): Promise<void> {
    requireAccountId(input.accountId);
    await this.db
      .insertInto('accounts')
      .values({
        account_id: input.accountId,
        subdomain: input.subdomain,
        status: input.status ?? 'active',
      })
      .onConflict((oc) =>
        oc.column('account_id').doUpdateSet({
          subdomain: input.subdomain,
          status: input.status ?? 'active',
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async findById(accountId: string) {
    requireAccountId(accountId);
    return this.db
      .selectFrom('accounts')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  }

  async getSettings(accountId: string): Promise<AccountSettings> {
    requireAccountId(accountId);
    const row = await this.db
      .selectFrom('accounts')
      .select('settings')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return (row?.settings ?? {}) as AccountSettings;
  }

  async updateSettings(accountId: string, settings: AccountSettings): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .updateTable('accounts')
      .set({ settings: JSON.stringify(settings), updated_at: new Date() })
      .where('account_id', '=', accountId)
      .execute();
  }
}
