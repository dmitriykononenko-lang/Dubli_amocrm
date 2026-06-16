import { Module } from '@nestjs/common';
import { RulesRepository } from './rules.repository';

/** Правила поиска дублей. Пока только чтение (для движка обнаружения); CRUD — следующий слой. */
@Module({
  providers: [RulesRepository],
  exports: [RulesRepository],
})
export class RulesModule {}
