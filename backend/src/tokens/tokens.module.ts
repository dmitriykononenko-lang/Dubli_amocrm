import { Module } from '@nestjs/common';
import { TokensRepository } from './tokens.repository';
import { TokensService } from './tokens.service';
import { AccountsModule } from '../accounts/accounts.module';
import { AmocrmHttpModule } from '../amocrm/amocrm-http.module';

@Module({
  imports: [AccountsModule, AmocrmHttpModule],
  providers: [TokensRepository, TokensService],
  exports: [TokensService],
})
export class TokensModule {}
