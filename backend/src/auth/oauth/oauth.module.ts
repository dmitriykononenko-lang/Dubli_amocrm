import { Module } from '@nestjs/common';
import { OauthController } from './oauth.controller';
import { OauthService } from './oauth.service';
import { AmocrmHttpModule } from '../../amocrm/amocrm-http.module';
import { AccountsModule } from '../../accounts/accounts.module';
import { TokensModule } from '../../tokens/tokens.module';
import { BillingModule } from '../../billing/billing.module';

@Module({
  imports: [AmocrmHttpModule, AccountsModule, TokensModule, BillingModule],
  controllers: [OauthController],
  providers: [OauthService],
})
export class OauthModule {}
