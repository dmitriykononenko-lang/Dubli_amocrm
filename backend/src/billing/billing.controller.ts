import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { BillingService } from './billing.service';

interface CheckoutBody {
  users?: number;
  months?: number;
  email?: string;
}

/**
 * Биллинг для виджета (`/api/billing`). security_key — заголовок/query, как у остальных API.
 * - GET  — предварительный расчёт суммы (тариф/срок).
 * - POST /invoice-request — заявка на счёт → сделка в нашей amoCRM.
 * - POST /checkout — онлайн-оплата (ЮKassa), пока 503 до настройки ключей.
 */
@Controller('api/billing')
@UseGuards(ApiSecurityGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  status(@Query('users') users?: string, @Query('months') months?: string) {
    return { quote: this.billing.quote(Number(users) || 0, Number(months) || 0) };
  }

  @Post('invoice-request')
  invoice(@AccountId() accountId: string, @Body() body: CheckoutBody) {
    return this.billing.requestInvoice(accountId, Number(body?.users), Number(body?.months));
  }

  @Post('checkout')
  checkout(@AccountId() accountId: string, @Body() body: CheckoutBody) {
    return this.billing.createCheckout(
      accountId,
      Number(body?.users),
      Number(body?.months),
      body?.email,
    );
  }
}
