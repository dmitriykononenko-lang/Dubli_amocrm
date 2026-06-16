// Валидные плейсхолдеры env ДО импорта AppModule (ConfigModule валидирует на импорте).
// Реальное подключение к тестовой БД подменяется через overrideProvider(PG_POOL) в e2e.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://placeholder@localhost:5432/db';
process.env.DATABASE_SSL ??= 'false';
process.env.TOKEN_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.AMOCRM_CLIENT_ID ??= 'test-client-id';
process.env.AMOCRM_CLIENT_SECRET ??= 'test-client-secret';
process.env.AMOCRM_REDIRECT_URI ??= 'https://example.com/oauth/callback';
