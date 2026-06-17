import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { KYSELY, PG_POOL } from '../src/common/db/kysely.tokens';
import type { DB } from '../src/common/db/database.types';
import { AmocrmService, type AmoPage } from '../src/amocrm/amocrm.service';
import { ScanService } from '../src/scan/scan.service';
import { applySchema } from './helpers/apply-schema';
import { dbAvailable, startTestDb, type TestDb } from './helpers/test-db';

const describeDb = dbAvailable() ? describe : describe.skip;

const ACCOUNT_ID = '781';
const SECURITY_KEY = 'scan-secret';

function contact(id: string, phone: string) {
  return {
    id,
    name: 'C' + id,
    custom_fields_values: [{ field_code: 'PHONE', values: [{ value: phone }] }],
  };
}

// In-memory листинг amoCRM: страницы по курсору (первая — при пустом path).
class FakeAmocrm {
  pages = new Map<string, AmoPage>();
  async listPage(_acc: string, _type: string, path?: string | null): Promise<AmoPage> {
    return (
      this.pages.get(path && path.length > 0 ? path : 'FIRST') ?? { items: [], nextPath: null }
    );
  }
}

describeDb('Scan e2e (POST /api/scan)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let scan: ScanService;
  let testDb: TestDb | null = null;
  const fake = new FakeAmocrm();

  function countEntities(): Promise<{ c: number | string | bigint }> {
    return db
      .selectFrom('entities')
      .select(db.fn.countAll().as('c'))
      .where('account_id', '=', ACCOUNT_ID)
      .executeTakeFirstOrThrow();
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
    scan = app.get(ScanService);
    await db
      .insertInto('accounts')
      .values({
        account_id: ACCOUNT_ID,
        subdomain: 'demo',
        settings: JSON.stringify({ security_key: SECURITY_KEY }),
      })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();

    // Две страницы: [401,402] → [403].
    fake.pages.set('FIRST', {
      items: [contact('401', '+7 999 111-11-11'), contact('402', '+7 999 222-22-22')],
      nextPath: '/api/v4/contacts?page=2',
    });
    fake.pages.set('/api/v4/contacts?page=2', {
      items: [contact('403', '+7 999 333-33-33')],
      nextPath: null,
    });
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.stop();
  });

  it('ставит задачу в очередь (POST) и отдаёт статус (GET)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/scan')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .send({ entity_type: 'contact' })
      .expect(201);
    expect(res.body).toMatchObject({ entity_type: 'contact', status: 'queued', progress: 0 });

    const status = await request(app.getHttpServer())
      .get(`/api/scan/${res.body.id}`)
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    expect(status.body.status).toBe('queued');
  });

  it('обрабатывает страницы по шагам до done и индексирует сущности', async () => {
    // шаг 1: первая страница → running, progress 2
    const r1 = await scan.processOnce();
    expect(r1).toMatchObject({ status: 'running', processed: 2 });
    expect(Number((await countEntities()).c)).toBe(2);

    // шаг 2: последняя страница → done, progress 3
    const r2 = await scan.processOnce();
    expect(r2).toMatchObject({ status: 'done', processed: 1 });
    expect(Number((await countEntities()).c)).toBe(3);

    // дальше задач нет
    expect(await scan.processOnce()).toMatchObject({ idle: true });

    // статус задачи через API
    const list = await request(app.getHttpServer())
      .get('/api/scan')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    expect(list.body[0]).toMatchObject({ status: 'done', progress: 3, total: 3 });
  });

  it('пауза исключает задачу из обработки, resume — продолжает', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/scan')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .send({ entity_type: 'contact' })
      .expect(201);
    const id = created.body.id;

    await scan.processOnce(); // первая страница → running
    await request(app.getHttpServer())
      .post(`/api/scan/${id}/pause`)
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);

    expect(await scan.processOnce()).toMatchObject({ idle: true }); // на паузе не берётся

    await request(app.getHttpServer())
      .post(`/api/scan/${id}/resume`)
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .expect(200);
    const done = await scan.processOnce(); // продолжает со второй страницы
    expect(done).toMatchObject({ status: 'done' });
  });

  it('невалидный entity_type → 400; без ключа → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/scan')
      .query({ account_id: ACCOUNT_ID })
      .set('X-Security-Key', SECURITY_KEY)
      .send({ entity_type: 'deal' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/scan')
      .query({ account_id: ACCOUNT_ID })
      .send({ entity_type: 'contact' })
      .expect(401);
  });
});
