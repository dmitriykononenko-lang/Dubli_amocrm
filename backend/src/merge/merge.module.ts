import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { EntitiesModule } from '../entities/entities.module';
import { DuplicatesModule } from '../duplicates/duplicates.module';
import { MergeController } from './merge.controller';
import { MergeService } from './merge.service';
import { MergeRepository } from './merge.repository';
import { AutoMergeService } from './auto-merge.service';

@Module({
  imports: [ApiAuthModule, AmocrmModule, EntitiesModule, DuplicatesModule],
  controllers: [MergeController],
  providers: [MergeService, MergeRepository, AutoMergeService],
  exports: [AutoMergeService],
})
export class MergeModule {}
