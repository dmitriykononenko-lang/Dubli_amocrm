import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
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

const ACCOUNT_ID = '782';
const SECURITY_KEY = 'auto-secret';

// In-memory amoCRM для операций слияния (getById клонирует, как настоящий HTTP).
class FakeAmocrm {
  store = new Map<string, Record<string, unknown>>();
  seed(type: EntityType, id: string, raw: Record<string, unknown>): void {
    this.store.set(`${type}:${id}`, raw);
  }
  async getById(_a: string, type: EntityType, id: string): Promise<Record<string, unknown>> {
    const e = this.store.get(`${type}:${id}`);
    if (!e) throw new Error('not found');
    return JSON.parse(JSON.stringify(e));
  }
  async update(): Promise<void> {}
  async remove(_a: string, type: EntityType, id: string): Promise<void> {
    this.store.delete(`${type}:${id}`);
  }
  async getLinks(): Promise<AmoLink[]> {
    return [];
  }
  async link(): Promise<void> {}
}

// Вебхук создания контакта (form-urlencoded, как шлёт amoCRM).
function webhookBody(amoId: string, phone: string): string {
  const p = new URLSearchParams();
  p.set('account[id]', ACCOUNT_ID);
  p.set('account[subdomain]', 'demo');
  p.set('contacts[add][0][id]', amoId);
  p.set('contacts[add][0][name]', 'C' + amoId);
  p.set('contacts[add][0][custom_fields_values][0][field_code]', 'PHONE');
  p.set('contacts[add][0][custom_fields_values][0][values][0][value]', phone);
  return p.toString();
}

describeDb('Auto-merge e2e (webhook → merge по правилу)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let testDb: TestDb | null = null;
  const fake = new FakeAmocrm();

  function existsEntity(amoId: string) {
    return db
      .selectFrom('entities')
      .select('amo_id')
      .where('account_id', '=', ACCOUNT_ID)
      .where('entity_type', '=', 'contact')
      .where('amo_id', '=', amoId)
      .executeTakeFirst();
  }

  async function postWebhook(amoId: string, phone: string) {
    return request(app.getHttpServer())
      .post('/webhooks/amo')
      .set('X-Security-Key', SECURITY_KEY)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(webhookBody(amoId, phone))
      .expect(200);
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

    // Правило: контакты, по телефону, auto_merge = true.
    await db
      .insertInto('rules')
      .values({
        account_id: ACCOUNT_ID,
        entity_type: 'contact',
        name: 'Авто по телефону',
        fields: JSON.stringify([{ key_type: 'phone' }]),
        operator: 'OR',
        auto_merge: true,
      })
      .execute();

    // amoCRM-состояние для операций слияния.
    const c = (id: string) => ({
      id,
      name: 'C' + id,
      custom_fields_values: [
        { field_id: 1, field_code: 'PHONE', values: [{ value: '+7 999 111-11-11' }] },
      ],
    });
    fake.seed('contact', '501', c('501'));
    fake.seed('contact', '502', c('502'));
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  it('первый контакт индексируется без слияния', async () => {
    await postWebhook('501', '+7 999 111-11-11');
    expect(await existsEntity('501')).toBeTruthy();
    const merges = await db
      .selectFrom('merge_journal')
      .selectAll()
      .where('account_id', '=', ACCOUNT_ID)
      .execute();
    expect(merges).toHaveLength(0);
  });

  it('второй контакт с тем же телефоном → авто-слияние (mode=auto), дубль удалён', async () => {
    await postWebhook('502', '+7 999 111-11-11');

    const journal = await db
      .selectFrom('merge_journal')
      .selectAll()
      .where('account_id', '=', ACCOUNT_ID)
      .execute();
    expect(journal).toHaveLength(1);
    // главная — более старая (меньший amo_id) 501, дубль — 502
    expect(journal[0]).toMatchObject({
      mode: 'auto',
      master_amo_id: '501',
      duplicate_amo_id: '502',
      author_user_id: null,
    });

    // 501 остался в индексе, 502 удалён
    expect(await existsEntity('501')).toBeTruthy();
    expect(await existsEntity('502')).toBeFalsy();
  });
});
