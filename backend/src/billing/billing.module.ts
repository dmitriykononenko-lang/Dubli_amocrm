import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [ApiAuthModule, AmocrmModule, AccountsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
