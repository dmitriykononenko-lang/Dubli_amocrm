import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { NormalizationModule } from './normalization/normalization.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, CryptoModule, NormalizationModule, HealthModule],
})
export class AppModule {}
