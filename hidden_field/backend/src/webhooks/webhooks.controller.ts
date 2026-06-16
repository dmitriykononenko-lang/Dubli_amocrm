import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhookAuthGuard } from './webhook-auth.guard';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  // amoCRM ждёт быстрый 200; обработка ядра лёгкая (нормализация + upsert).
  @Post('amo')
  @UseGuards(WebhookAuthGuard)
  @HttpCode(200)
  async amo(@Body() body: unknown): Promise<{ ok: true; processed: number; skipped: number }> {
    const result = await this.service.process(body);
    return { ok: true, ...result };
  }
}
