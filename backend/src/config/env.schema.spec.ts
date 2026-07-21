import { validateEnv } from './env.schema';

/** Минимально валидное окружение; в тестах переопределяем только нужные поля. */
function baseEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    TOKEN_ENC_KEY: Buffer.alloc(32).toString('base64'),
    AMOCRM_CLIENT_ID: 'id',
    AMOCRM_CLIENT_SECRET: 'secret',
    AMOCRM_REDIRECT_URI: 'https://example.com/oauth/callback',
    ...overrides,
  };
}

describe('validateEnv — DATABASE_SSL', () => {
  it('по умолчанию true (Selectel managed PG требует TLS)', () => {
    expect(validateEnv(baseEnv()).DATABASE_SSL).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' false '])(
    'строка %p → false (регрессия z.coerce.boolean, который дал бы true)',
    (v) => {
      expect(validateEnv(baseEnv({ DATABASE_SSL: v })).DATABASE_SSL).toBe(false);
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('строка %p → true', (v) => {
    expect(validateEnv(baseEnv({ DATABASE_SSL: v })).DATABASE_SSL).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
  ])('boolean %p проходит как есть', (input, expected) => {
    expect(validateEnv(baseEnv({ DATABASE_SSL: input })).DATABASE_SSL).toBe(expected);
  });

  it('нераспознанное значение — ошибка конфигурации', () => {
    expect(() => validateEnv(baseEnv({ DATABASE_SSL: 'maybe' }))).toThrow(
      /Невалидная конфигурация окружения/,
    );
  });
});
