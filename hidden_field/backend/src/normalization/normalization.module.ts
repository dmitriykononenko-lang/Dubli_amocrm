import { Module } from '@nestjs/common';
import { NormalizationService } from './normalization.service';

@Module({
  providers: [NormalizationService],
  exports: [NormalizationService],
})
export class NormalizationModule {}
