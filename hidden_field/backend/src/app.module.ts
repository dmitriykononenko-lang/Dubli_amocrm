import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { AmocrmModule } from './amocrm/amocrm.module';
import { OauthModule } from './auth/oauth/oauth.module';
import { VisibilityModule } from './visibility/visibility.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // Глобальные: конфиг, БД, crypto, аудит.
    AppConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    // Фичи.
    AmocrmModule,
    OauthModule,
    VisibilityModule,
    HealthModule,
  ],
})
export class AppModule {}
