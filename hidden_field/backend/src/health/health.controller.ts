import { Controller, Get, Inject } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import type { DB } from '../common/db/database.types';

@Controller('health')
export class HealthController {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  @Get()
  async check(): Promise<{ status: string; db: boolean; ts: string }> {
    let db = false;
    try {
      await sql`select 1`.execute(this.db);
      db = true;
    } catch {
      db = false;
    }
    return { status: db ? 'ok' : 'degraded', db, ts: new Date().toISOString() };
  }
}
