import { Module } from '@nestjs/common';
import { AmocrmHttpModule } from './amocrm-http.module';
import { AmocrmService } from './amocrm.service';
import { TokensModule } from '../tokens/tokens.module';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [AmocrmHttpModule, TokensModule, AccountsModule],
  providers: [AmocrmService],
  exports: [AmocrmService],
})
export class AmocrmModule {}
