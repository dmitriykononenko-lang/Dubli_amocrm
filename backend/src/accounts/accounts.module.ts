import { Module } from '@nestjs/common';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';

@Module({
  providers: [AccountsRepository, AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
