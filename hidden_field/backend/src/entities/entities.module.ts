import { Module } from '@nestjs/common';
import { EntitiesRepository } from './entities.repository';
import { EntitiesService } from './entities.service';
import { NormalizationModule } from '../normalization/normalization.module';

@Module({
  imports: [NormalizationModule],
  providers: [EntitiesRepository, EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
