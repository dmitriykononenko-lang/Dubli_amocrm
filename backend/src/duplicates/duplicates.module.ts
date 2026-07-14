import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { RulesModule } from '../rules/rules.module';
import { DuplicatesController } from './duplicates.controller';
import { DuplicatesService } from './duplicates.service';
import { DuplicatesRepository } from './duplicates.repository';

@Module({
  imports: [ApiAuthModule, RulesModule],
  controllers: [DuplicatesController],
  providers: [DuplicatesService, DuplicatesRepository],
  exports: [DuplicatesService],
})
export class DuplicatesModule {}
