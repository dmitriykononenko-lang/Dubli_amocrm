import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { EntitiesModule } from '../entities/entities.module';
import { MergeController } from './merge.controller';
import { MergeService } from './merge.service';
import { MergeRepository } from './merge.repository';

@Module({
  imports: [ApiAuthModule, AmocrmModule, EntitiesModule],
  controllers: [MergeController],
  providers: [MergeService, MergeRepository],
})
export class MergeModule {}
