import type { Provider } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import { KYSELY, PG_POOL } from './kysely.tokens';
import type { DB } from './database.types';

export const kyselyProvider: Provider = {
  provide: KYSELY,
  inject: [PG_POOL],
  useFactory: (pool: Pool): Kysely<DB> =>
    new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }),
};
