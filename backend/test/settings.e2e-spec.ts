import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB, AccountSettings } from '../src/common/db/database.types';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '780';
const SECURITY_KEY = 'cfg-secret';

function auth(req: request.Test): request.Test {
  return req.query({ account_id: ACCOUNT_ID }).set('X-Security-Key', SECURITY_KEY);
}

describeDb('Rules CRUD + Settings e2e (/api/rules, /api/settings)', () => {
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
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  describe('правила', () => {
    let ruleId = '';

    it('создаёт правило (POST) с дефолтами', async () => {
      const res = await auth(request(app.getHttpServer()).post('/api/rules'))
        .send({ entity_type: 'contact', name: 'По телефону', fields: [{ key_type: 'phone' }] })
        .expect(201);
      expect(res.body).toMatchObject({
        entity_type: 'contact',
        name: 'По телефону',
        fields: [{ key_type: 'phone' }],
        operator: 'AND',
        auto_merge: false,
        enabled: true,
      });
      ruleId = res.body.id;
      expect(ruleId).toBeTruthy();
    });

    it('список (GET) и фильтр по сущности', async () => {
      const all = await auth(request(app.getHttpServer()).get('/api/rules')).expect(200);
      expect(all.body).toHaveLength(1);
      const leads = await auth(request(app.getHttpServer()).get('/api/rules'))
        .query({ entity_type: 'lead' })
        .expect(200);
      expect(leads.body).toHaveLength(0);
    });

    it('обновляет (PATCH) только переданные поля', async () => {
      const res = await auth(request(app.getHttpServer()).patch(`/api/rules/${ruleId}`))
        .send({ enabled: false, operator: 'OR' })
        .expect(200);
      expect(res.body).toMatchObject({ enabled: false, operator: 'OR', name: 'По телефону' });
    });

    it('PATCH несуществующего → 404; невалидное тело → 400', async () => {
      await auth(request(app.getHttpServer()).patch('/api/rules/999999'))
        .send({ enabled: false })
        .expect(404);
      await auth(request(app.getHttpServer()).post('/api/rules'))
        .send({ entity_type: 'contact', name: 'нет полей', fields: [] })
        .expect(400);
    });

    it('удаляет (DELETE), повтор → 404', async () => {
      await auth(request(app.getHttpServer()).delete(`/api/rules/${ruleId}`)).expect(200);
      await auth(request(app.getHttpServer()).delete(`/api/rules/${ruleId}`)).expect(404);
      const all = await auth(request(app.getHttpServer()).get('/api/rules')).expect(200);
      expect(all.body).toHaveLength(0);
    });

    it('без security_key → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/rules')
        .query({ account_id: ACCOUNT_ID })
        .expect(401);
    });
  });

  describe('настройки', () => {
    it('GET возвращает дефолты', async () => {
      const res = await auth(request(app.getHttpServer()).get('/api/settings')).expect(200);
      expect(res.body).toEqual({
        entities: { contact: true, company: true, lead: true },
        prevent_create: false,
      });
    });

    it('PUT сохраняет и не затирает security_key', async () => {
      const res = await auth(request(app.getHttpServer()).put('/api/settings'))
        .send({ entities: { contact: true, company: false, lead: true }, prevent_create: true })
        .expect(200);
      expect(res.body).toEqual({
        entities: { contact: true, company: false, lead: true },
        prevent_create: true,
      });

      const got = await auth(request(app.getHttpServer()).get('/api/settings')).expect(200);
      expect(got.body.entities.company).toBe(false);
      expect(got.body.prevent_create).toBe(true);

      // security_key в accounts.settings сохранился рядом с dedup
      const row = await db
        .selectFrom('accounts')
        .select('settings')
        .where('account_id', '=', ACCOUNT_ID)
        .executeTakeFirstOrThrow();
      const settings = row.settings as AccountSettings;
      expect(settings.security_key).toBe(SECURITY_KEY);
      expect((settings.dedup as { prevent_create?: boolean })?.prevent_create).toBe(true);
    });
  });
});
