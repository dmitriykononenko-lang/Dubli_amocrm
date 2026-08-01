import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { VendorBillingController } from './vendor-billing.controller';
import { VendorWebhookController } from './vendor-webhook.controller';
import { BillingService } from './billing.service';
import { YookassaClient } from './yookassa.client';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';
import { VendorTokenGuard } from './vendor-token.guard';

@Module({
  imports: [ApiAuthModule, AmocrmModule, AccountsModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    VendorBillingController,
    VendorWebhookController,
  ],
  providers: [
    BillingService,
    YookassaClient,
    SubscriptionsRepository,
    SubscriptionsService,
    VendorTokenGuard,
  ],
  exports: [BillingService, SubscriptionsService],
})
export class BillingModule {}
