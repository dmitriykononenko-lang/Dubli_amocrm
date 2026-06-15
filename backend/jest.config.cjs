// Юнит-тесты (без БД/сети): нормализация, crypto, сервисы с моками.
// Лежат рядом с кодом в src/**/*.spec.ts. e2e — в отдельном конфиге jest-e2e.config.cjs.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
