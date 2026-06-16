import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB } from '../src/common/db/database.types';
import { EntitiesService } from '../src/entities/entities.service';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

// Без Docker/DATABASE_URL_TEST — e2e с БД пропускаются (юнит-тесты остаются зелёными).
const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '778';
const SECURITY_KEY = 'dup-secret';

// Контакт amoCRM с телефоном (custom_fields_values как в вебхуке).
function contact(id: string, name: string, phone: string) {
  return {
    id,
    name,
    custom_fields_values: [{ field_code: 'PHONE', values: [{ value: phone }] }],
  };
}

describeDb('Duplicates e2e (GET /api/duplicates)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let testDb: TestDb | null = null;

  beforeAll(async () => {
    testDb = await startTestDb();
    if (!testDb) return;
    await applySchema(testDb.connectionString);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useFactory({ factory: () => new Pool({ connectionString: testDb!.connectionString }) })
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

    // 201 и 202 делят телефон (разные форматы → один key_norm); 203 — другой телефон.
    const entities = app.get(EntitiesService);
    await entities.indexEntity(
      ACCOUNT_ID,
      'contact',
      '201',
      contact('201', 'Иван Петров', '+7 999 111-22-33'),
    );
    await entities.indexEntity(
      ACCOUNT_ID,
      'contact',
      '202',
      contact('202', 'Пётр Иванов', '8 (999) 111-22-33'),
    );
    await entities.indexEntity(
      ACCOUNT_ID,
      'contact',
      '203',
      contact('203', 'Сидор Сидоров', '+7 999 555-66-77'),
    );
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  it('находит дубль по общему телефону (без правил — фолбэк)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'contact', amo_id: '201' })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);

    expect(res.body.entity).toEqual({ entity_type: 'contact', amo_id: '201', indexed: true });
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates).toHaveLength(1);
    const dup = res.body.duplicates[0];
    expect(dup.amo_id).toBe('202');
    expect(dup.name).toBe('Пётр Иванов');
    expect(dup.matched_rules).toEqual([]);
    expect(dup.matched_keys).toEqual([{ key_type: 'phone', key_norm: '9991112233' }]);
  });

  it('принимает множественное число entity_type (contacts)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'contacts', amo_id: '202' })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates[0].amo_id).toBe('201');
  });

  it('у сущности без совпадений дублей нет', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'contact', amo_id: '203' })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    expect(res.body).toMatchObject({ count: 0, duplicates: [] });
  });

  it('непроиндексированная сущность → indexed:false', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'contact', amo_id: '999999' })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    expect(res.body).toMatchObject({
      entity: { entity_type: 'contact', amo_id: '999999', indexed: false },
      count: 0,
      duplicates: [],
    });
  });

  it('неверный security_key → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'contact', amo_id: '201' })
      .set('X-Security-Key', 'wrong')
      .expect(401);
  });

  it('невалидный entity_type → 400', async () => {
    await request(app.getHttpServer())
      .get('/api/duplicates')
      .query({ account_id: ACCOUNT_ID, entity_type: 'deal', amo_id: '201' })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(400);
  });

  it('правило «совпадение по email» отсекает совпадение только по телефону', async () => {
    const inserted = await db
      .insertInto('rules')
      .values({
        account_id: ACCOUNT_ID,
        entity_type: 'contact',
        name: 'Только по email',
        fields: JSON.stringify([{ key_type: 'email' }]),
        operator: 'OR',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      const res = await request(app.getHttpServer())
        .get('/api/duplicates')
        .query({ account_id: ACCOUNT_ID, entity_type: 'contact', amo_id: '201' })
        .set('X-Security-Key', SECURITY_KEY)
        .expect(200);
      // 201 и 202 делят только телефон, а правило требует email → дублей нет.
      expect(res.body.count).toBe(0);
    } finally {
      await db.deleteFrom('rules').where('id', '=', inserted.id).execute();
    }
  });
});
