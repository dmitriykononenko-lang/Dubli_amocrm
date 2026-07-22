import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingService } from './billing.service';
import { YookassaClient } from './yookassa.client';

@Module({
  imports: [ApiAuthModule, AmocrmModule, AccountsModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [BillingService, YookassaClient],
  exports: [BillingService],
})
export class BillingModule {}
