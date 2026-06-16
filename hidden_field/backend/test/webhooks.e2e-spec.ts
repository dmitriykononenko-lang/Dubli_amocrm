import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB } from '../src/common/db/database.types';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

// Без Docker/DATABASE_URL_TEST — e2e с БД пропускаются (юнит-тесты остаются зелёными).
const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '777';
const SECURITY_KEY = 'secret-key';

// Тело вебхука amoCRM: form-urlencoded с вложенными массивами (contacts[add][0][...]).
function webhookBody(): string {
  const p = new URLSearchParams();
  p.set('account[id]', ACCOUNT_ID);
  p.set('account[subdomain]', 'demo');
  p.set('contacts[add][0][id]', '100');
  p.set('contacts[add][0][name]', 'ООО "Ромашка"');
  p.set('contacts[add][0][updated_at]', '1700000000');
  p.set('contacts[add][0][custom_fields_values][0][field_code]', 'PHONE');
  p.set('contacts[add][0][custom_fields_values][0][values][0][value]', '+7 999 123-45-67');
  p.set('contacts[add][0][custom_fields_values][1][field_code]', 'EMAIL');
  p.set('contacts[add][0][custom_fields_values][1][values][0][value]', 'Test@Example.com');
  return p.toString();
}

describeDb('Webhooks e2e (POST /webhooks/amo)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let testDb: TestDb | null = null;

  beforeAll(async () => {
    testDb = await startTestDb();
    if (!testDb) return;
    await applySchema(testDb.connectionString);

    // env-плейсхолдеры заданы в test/setup-env.ts (проходят валидацию конфига).
    // Реальное подключение подменяем на тестовую БД через PG_POOL.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useFactory({ factory: () => new Pool({ connectionString: testDb!.connectionString }) })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(urlencoded({ extended: true }));
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
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  it('валидный вебхук индексирует сущность в entity_keys', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/amo')
      .set('X-Security-Key', SECURITY_KEY)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(webhookBody())
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, processed: 1, skipped: 0 });

    const keys = await db
      .selectFrom('entity_keys')
      .selectAll()
      .where('account_id', '=', ACCOUNT_ID)
      .execute();
    // name + phone + email
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.key_type === 'phone' && k.key_norm === '9991234567')).toBe(true);
    expect(keys.some((k) => k.key_type === 'email' && k.key_norm === 'test@example.com')).toBe(
      true,
    );
  });

  it('повторная доставка идемпотентна (skipped, без дублей ключей)', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/amo')
      .set('X-Security-Key', SECURITY_KEY)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(webhookBody())
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, processed: 0, skipped: 1 });

    const count = await db
      .selectFrom('entity_keys')
      .select(db.fn.countAll().as('c'))
      .where('account_id', '=', ACCOUNT_ID)
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(3);
  });

  it('неверный security_key → 401', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/amo')
      .set('X-Security-Key', 'wrong')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(webhookBody())
      .expect(401);
  });
});
