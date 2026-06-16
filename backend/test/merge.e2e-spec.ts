import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB, EntityType } from '../src/common/db/database.types';
import { AmocrmService, type AmoLink } from '../src/amocrm/amocrm.service';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '779';
const SECURITY_KEY = 'merge-secret';

// In-memory amoCRM: getById клонирует (как настоящий HTTP) — снимок фиксирует состояние до merge.
class FakeAmocrm {
  store = new Map<string, Record<string, unknown>>();
  links = new Map<string, AmoLink[]>();
  private nextId = 90000;

  seed(type: EntityType, id: string, raw: Record<string, unknown>): void {
    this.store.set(`${type}:${id}`, raw);
  }
  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
  }
  async getById(_acc: string, type: EntityType, id: string): Promise<Record<string, unknown>> {
    const e = this.store.get(`${type}:${id}`);
    if (!e) throw new Error('not found');
    return this.clone(e);
  }
  async update(
    _acc: string,
    type: EntityType,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const e = this.store.get(`${type}:${id}`) ?? {};
    if (patch.name !== undefined) e.name = patch.name;
    if (patch.custom_fields_values) {
      e.custom_fields_values = [
        ...((e.custom_fields_values as unknown[]) ?? []),
        ...(patch.custom_fields_values as unknown[]),
      ];
    }
    this.store.set(`${type}:${id}`, e);
  }
  async remove(_acc: string, type: EntityType, id: string): Promise<void> {
    this.store.delete(`${type}:${id}`);
  }
  async getLinks(_acc: string, type: EntityType, id: string): Promise<AmoLink[]> {
    return this.links.get(`${type}:${id}`) ?? [];
  }
  async link(): Promise<void> {
    /* связи в фейке не материализуем */
  }
  async create(_acc: string, type: EntityType, payload: Record<string, unknown>): Promise<string> {
    const id = String(this.nextId++);
    this.store.set(`${type}:${id}`, { id, ...payload });
    return id;
  }
}

function contact(
  id: string,
  name: string,
  code: 'PHONE' | 'EMAIL',
  fieldId: number,
  value: string,
) {
  return {
    id,
    name,
    custom_fields_values: [{ field_id: fieldId, field_code: code, values: [{ value }] }],
  };
}

describeDb('Merge e2e (POST /api/merge)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let testDb: TestDb | null = null;
  const fake = new FakeAmocrm();

  async function keysOf(amoId: string) {
    const e = await db
      .selectFrom('entities')
      .select('id')
      .where('account_id', '=', ACCOUNT_ID)
      .where('entity_type', '=', 'contact')
      .where('amo_id', '=', amoId)
      .executeTakeFirst();
    if (!e) return [];
    return db.selectFrom('entity_keys').selectAll().where('entity_id', '=', e.id).execute();
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    if (!testDb) return;
    await applySchema(testDb.connectionString);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useFactory({ factory: () => new Pool({ connectionString: testDb!.connectionString }) })
      .overrideProvider(AmocrmService)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(json());
    await app.init();

    db = app.get<Kysely<DB>>(KYSELY);
    await db
      .insertInto('accounts')
      .values({
        account_id: ACCOUNT_ID,
        subdomain: 'demo',
        settings: JSON.stringify({ security_key: SECURITY_KEY }),
      })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();

    // master 301 — телефон; duplicate 302 — email (другое поле → перенос gap-fill).
    fake.seed('contact', '301', contact('301', 'Иван Петров', 'PHONE', 1, '+7 999 111-22-33'));
    fake.seed('contact', '302', contact('302', 'Иван П.', 'EMAIL', 2, 'ivan@example.com'));
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  let mergeId = '';

  it('объединяет: журнал + снимки, перенос email, удаление дубля из индекса', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/merge')
      .set('X-Security-Key', SECURITY_KEY)
      .query({ account_id: ACCOUNT_ID })
      .send({
        entity_type: 'contact',
        master_amo_id: '301',
        duplicate_amo_id: '302',
        author_user_id: 42,
      })
      .expect(200);

    expect(res.body.master_amo_id).toBe('301');
    expect(res.body.transferred.field_ids).toContain(2);
    mergeId = res.body.mergeId;
    expect(mergeId).toBeTruthy();

    const journal = await db
      .selectFrom('merge_journal')
      .selectAll()
      .where('account_id', '=', ACCOUNT_ID)
      .where('id', '=', mergeId)
      .executeTakeFirstOrThrow();
    expect(journal).toMatchObject({
      master_amo_id: '301',
      duplicate_amo_id: '302',
      mode: 'manual',
      author_user_id: '42',
      rolled_back_at: null,
    });

    const snaps = await db
      .selectFrom('snapshots')
      .selectAll()
      .where('merge_id', '=', mergeId)
      .execute();
    expect(snaps.map((s) => s.amo_id).sort()).toEqual(['301', '302']);

    // дубль удалён из локального индекса, главная переиндексирована с email
    expect(await keysOf('302')).toHaveLength(0);
    const masterKeys = await keysOf('301');
    expect(
      masterKeys.some((k) => k.key_type === 'email' && k.key_norm === 'ivan@example.com'),
    ).toBe(true);
    expect(masterKeys.some((k) => k.key_type === 'phone')).toBe(true);
  });

  it('откат: восстанавливает дубль (новый id) и помечает журнал', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/merge/${mergeId}/rollback`)
      .set('X-Security-Key', SECURITY_KEY)
      .query({ account_id: ACCOUNT_ID })
      .send({})
      .expect(200);

    const newId = res.body.restored_duplicate_amo_id;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe('302');

    const journal = await db
      .selectFrom('merge_journal')
      .select('rolled_back_at')
      .where('id', '=', mergeId)
      .executeTakeFirstOrThrow();
    expect(journal.rolled_back_at).not.toBeNull();

    // главная переиндексирована по снимку (email убран), воссозданный дубль — в индексе
    const masterKeys = await keysOf('301');
    expect(masterKeys.some((k) => k.key_type === 'email')).toBe(false);
    expect(await keysOf(newId)).not.toHaveLength(0);
  });

  it('повторный откат → 400', async () => {
    await request(app.getHttpServer())
      .post(`/api/merge/${mergeId}/rollback`)
      .set('X-Security-Key', SECURITY_KEY)
      .query({ account_id: ACCOUNT_ID })
      .send({})
      .expect(400);
  });

  it('без security_key → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/merge')
      .query({ account_id: ACCOUNT_ID })
      .send({ entity_type: 'contact', master_amo_id: '301', duplicate_amo_id: '302' })
      .expect(401);
  });
});
