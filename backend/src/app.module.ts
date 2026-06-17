import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { AmocrmModule } from './amocrm/amocrm.module';
import { OauthModule } from './auth/oauth/oauth.module';
import { EntitiesModule } from './entities/entities.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DuplicatesModule } from './duplicates/duplicates.module';
import { MergeModule } from './merge/merge.module';
import { RulesModule } from './rules/rules.module';
import { SettingsModule } from './settings/settings.module';
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
    EntitiesModule,
    WebhooksModule,
    DuplicatesModule,
    MergeModule,
    RulesModule,
    SettingsModule,
    HealthModule,
  ],
})
export class AppModule {}
