import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

/** Применяет baseline-схему backend/db/schema.sql к тестовой БД (файл идемпотентен). */
export async function applySchema(connectionString: string): Promise<void> {
  const schemaPath = join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  const pool = new Pool({ connectionString });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}
