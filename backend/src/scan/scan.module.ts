import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { EntitiesModule } from '../entities/entities.module';
import { ScanController } from './scan.controller';
import { ScanService } from './scan.service';
import { ScanJobsRepository } from './scan.repository';
import { ScanProcessor } from './scan.processor';

@Module({
  imports: [ApiAuthModule, AmocrmModule, EntitiesModule],
  controllers: [ScanController],
  providers: [ScanService, ScanJobsRepository, ScanProcessor],
})
export class ScanModule {}
