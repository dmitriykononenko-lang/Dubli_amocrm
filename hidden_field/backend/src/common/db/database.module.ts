import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { pgPoolProvider } from './pg-pool.provider';
import { kyselyProvider } from './kysely.provider';
import { KYSELY, PG_POOL } from './kysely.tokens';
import type { DB } from './database.types';

@Global()
@Module({
  providers: [pgPoolProvider, kyselyProvider],
  exports: [KYSELY, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  // destroy() закрывает Kysely и нижележащий пул pg.
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
