import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB } from '../src/common/db/database.types';
import { AmocrmService } from '../src/amocrm/amocrm.service';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

// Без Docker/DATABASE_URL_TEST — e2e с БД пропускаются (юнит-тесты остаются зелёными).
const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '778';
const SECURITY_KEY = 'hf-secret';
const USER = '500';

// amoCRM замокан: meta берёт поля/пользователей/воронки отсюда (без реальной сети).
const amocrmStub: Partial<AmocrmService> = {
  getCustomFields: async (_accountId, entity) =>
    entity === 'lead' ? [{ id: 111, name: 'Бюджет' }] : [],
  getUsers: async () => [{ id: 500, name: 'Менеджер' }],
  getPipelines: async () => [{ id: 1, name: 'Продажи' }],
};

describeDb('Hidden Field e2e (matrix/config/meta)', () => {
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
      .overrideProvider(AmocrmService)
      .useValue(amocrmStub)
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

  it('сохраняет матрицу и отдаёт конфиг пользователю (O и чужие строки отфильтрованы)', async () => {
    await request(app.getHttpServer())
      .post('/api/matrix')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .send({ matrix: { '111:500': 'S', '222:500': 'O', '333:501': '*' } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/config')
      .query({ account_id: ACCOUNT_ID, user_id: USER })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);

    expect(res.body.rules).toEqual({ '111': { '*': { '*': 'S' } } });
    expect(res.body.funnels).toEqual({});
  });

  it('meta возвращает поля/пользователей/воронки и текущую матрицу', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/meta')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);

    expect(res.body.users).toEqual([{ id: '500', name: 'Менеджер' }]);
    expect(res.body.pipelines).toEqual([{ id: '1', name: 'Продажи' }]);
    expect(res.body.fields).toContainEqual({ id: '111', name: 'Бюджет', entity: 'lead' });
    expect(res.body.matrix['111:500']).toBe('S');
  });

  it('неверный security_key → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/matrix')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', 'wrong')
      .send({ matrix: {} })
      .expect(401);
  });
});
