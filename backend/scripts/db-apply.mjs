// Применяет baseline-схему db/schema.sql к БД по DATABASE_URL, используя pg (без psql).
// Портируемо для Docker/CI. Схема идемпотентна — безопасно запускать повторно.
// Запуск: DATABASE_URL=postgres://... node scripts/db-apply.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

// SSL: sslmode=require в строке или DATABASE_SSL=true.
const ssl =
  /[?&]sslmode=require/.test(connectionString) || process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

const pool = new pg.Pool({ connectionString, ssl });

// Небольшой ретрай — БД в docker-compose может подниматься чуть дольше.
const attempts = Number(process.env.DB_APPLY_RETRIES ?? 10);
for (let i = 1; i <= attempts; i++) {
  try {
    await pool.query(sql);
    console.log('schema.sql применён.');
    await pool.end();
    process.exit(0);
  } catch (e) {
    if (i === attempts) {
      console.error(`Не удалось применить схему: ${e.message}`);
      await pool.end();
      process.exit(1);
    }
    console.log(`БД недоступна (попытка ${i}/${attempts}): ${e.message} — жду 2с…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
