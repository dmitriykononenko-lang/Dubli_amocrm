import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { RulesRepository } from './rules.repository';
import { RulesController } from './rules.controller';

/** Правила поиска дублей: чтение для движка обнаружения + CRUD для настроек. */
@Module({
  imports: [ApiAuthModule],
  controllers: [RulesController],
  providers: [RulesRepository],
  exports: [RulesRepository],
})
export class RulesModule {}
