import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { parseAmoId, parseEntityTypeParam } from '../common/request-params';
import { ScanService, type ScanJobDto } from './scan.service';

/** Фоновое массовое сканирование базы аккаунта. */
@Controller('api/scan')
@UseGuards(ApiSecurityGuard)
export class ScanController {
  constructor(private readonly service: ScanService) {}

  @Post()
  @HttpCode(201)
  enqueue(
    @AccountId() accountId: string,
    @Body() body: { entity_type?: unknown },
  ): Promise<ScanJobDto> {
    const entityType = parseEntityTypeParam(body?.entity_type);
    if (!entityType) throw new BadRequestException('entity_type должен быть contact|company|lead');
    return this.service.enqueue(accountId, entityType);
  }

  @Get()
  list(@AccountId() accountId: string): Promise<ScanJobDto[]> {
    return this.service.list(accountId);
  }

  @Get(':id')
  get(@AccountId() accountId: string, @Param('id') id: string): Promise<ScanJobDto> {
    return this.service.get(accountId, requireId(id));
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@AccountId() accountId: string, @Param('id') id: string): Promise<ScanJobDto> {
    return this.service.pause(accountId, requireId(id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@AccountId() accountId: string, @Param('id') id: string): Promise<ScanJobDto> {
    return this.service.resume(accountId, requireId(id));
  }
}

function requireId(raw: string): string {
  const id = parseAmoId(raw);
  if (!id) throw new BadRequestException('Некорректный id задачи');
  return id;
}
