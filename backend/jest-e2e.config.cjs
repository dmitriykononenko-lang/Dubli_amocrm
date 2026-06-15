// e2e-тесты (требуют PostgreSQL: testcontainers или DATABASE_URL_TEST).
// Файлы: test/**/*.e2e-spec.ts.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testRegex: '\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testTimeout: 120000,
};
