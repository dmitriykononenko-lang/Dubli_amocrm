import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookAuthGuard } from './webhook-auth.guard';
import { AccountsModule } from '../accounts/accounts.module';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [AccountsModule, EntitiesModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookEventsRepository, WebhookAuthGuard],
})
export class WebhooksModule {}
