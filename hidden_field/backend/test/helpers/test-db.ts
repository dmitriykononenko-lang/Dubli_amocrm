import { existsSync } from 'node:fs';

export interface TestDb {
  connectionString: string;
  stop: () => Promise<void>;
}

/** Можно ли запускать e2e с БД: есть DATABASE_URL_TEST или доступен Docker. */
export function dbAvailable(): boolean {
  if (process.env.DATABASE_URL_TEST) return true;
  if (process.env.DOCKER_HOST) return true;
  return existsSync('/var/run/docker.sock');
}

/**
 * Поднимает тестовую БД: приоритет — DATABASE_URL_TEST (внешний PG),
 * иначе testcontainers (postgres:16-alpine). Возвращает null, если ничего недоступно.
 */
export async function startTestDb(): Promise<TestDb | null> {
  if (process.env.DATABASE_URL_TEST) {
    return { connectionString: process.env.DATABASE_URL_TEST, stop: async () => undefined };
  }
  try {
    const mod = await import('@testcontainers/postgresql');
    const container = await new mod.PostgreSqlContainer('postgres:16-alpine').start();
    return {
      connectionString: container.getConnectionUri(),
      stop: () => container.stop().then(() => undefined),
    };
  } catch {
    return null;
  }
}
