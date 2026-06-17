import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { parseAmoId, parseEntityTypeParam } from '../common/request-params';
import { RulesRepository, type RuleRow } from './rules.repository';
import { parseRuleInput, parseRulePatch } from './rule-input';

/** CRUD правил поиска дублей для экрана настроек виджета. */
@Controller('api/rules')
@UseGuards(ApiSecurityGuard)
export class RulesController {
  constructor(private readonly repo: RulesRepository) {}

  @Get()
  list(
    @AccountId() accountId: string,
    @Query('entity_type') entityTypeRaw?: string,
  ): Promise<RuleRow[]> {
    const entityType = entityTypeRaw ? parseEntityTypeParam(entityTypeRaw) : undefined;
    if (entityTypeRaw && !entityType) {
      throw new BadRequestException('entity_type должен быть contact|company|lead');
    }
    return this.repo.list(accountId, entityType ?? undefined);
  }

  @Post()
  @HttpCode(201)
  create(@AccountId() accountId: string, @Body() body: Record<string, unknown>): Promise<RuleRow> {
    return this.repo.create(accountId, parseRuleInput(body ?? {}));
  }

  @Patch(':id')
  async update(
    @AccountId() accountId: string,
    @Param('id') idRaw: string,
    @Body() body: Record<string, unknown>,
  ): Promise<RuleRow> {
    const id = parseAmoId(idRaw);
    if (!id) throw new BadRequestException('Некорректный id правила');
    const updated = await this.repo.update(accountId, id, parseRulePatch(body ?? {}));
    if (!updated) throw new NotFoundException('Правило не найдено');
    return updated;
  }

  @Delete(':id')
  async remove(
    @AccountId() accountId: string,
    @Param('id') idRaw: string,
  ): Promise<{ deleted: true }> {
    const id = parseAmoId(idRaw);
    if (!id) throw new BadRequestException('Некорректный id правила');
    const ok = await this.repo.remove(accountId, id);
    if (!ok) throw new NotFoundException('Правило не найдено');
    return { deleted: true };
  }
}
