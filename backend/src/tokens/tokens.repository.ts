import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB } from '../common/db/database.types';

export interface TokenRow {
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer;
  nonce: Buffer;
  kmsKeyRef: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

@Injectable()
export class TokensRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async upsert(accountId: string, row: TokenRow): Promise<void> {
    requireAccountId(accountId);
    const values = {
      access_token_enc: row.accessTokenEnc,
      refresh_token_enc: row.refreshTokenEnc,
      nonce: row.nonce,
      kms_key_ref: row.kmsKeyRef,
      access_expires_at: row.accessExpiresAt,
      refresh_expires_at: row.refreshExpiresAt,
      rotated_at: new Date(),
    };
    await this.db
      .insertInto('oauth_tokens')
      .values({ account_id: accountId, ...values })
      .onConflict((oc) => oc.column('account_id').doUpdateSet(values))
      .execute();
  }

  async find(accountId: string) {
    requireAccountId(accountId);
    return this.db
      .selectFrom('oauth_tokens')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  }
}
