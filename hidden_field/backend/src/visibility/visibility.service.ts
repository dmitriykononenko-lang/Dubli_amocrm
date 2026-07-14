import { BadRequestException, Injectable } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import { AuditService } from '../common/audit/audit.service';
import { AmocrmService } from '../amocrm/amocrm.service';
import type { EntityType, FieldMode } from '../common/db/database.types';
import { VisibilityRepository, type FunnelRow, type MatrixRow } from './visibility.repository';

const MODES: FieldMode[] = ['O', 'S', '*', 'B', 'V'];
// Режимы, допустимые на уровне воронки: V наследовать нельзя, O — по умолчанию (не хранится).
const FUNNEL_MODES: FieldMode[] = ['S', '*', 'B'];
const ENTITIES: EntityType[] = ['lead', 'contact', 'company'];

// Системные поля amoCRM (нет в custom_fields API) — добавляем в матрицу вручную.
// Синтетический id «sys_<entity>_<code>» уникален по сущности и не содержит ':'
// (безопасно для ключа матрицы "field:user").
const SYSTEM_FIELDS: Record<EntityType, Array<{ code: string; name: string }>> = {
  lead: [
    { code: 'name', name: 'Название сделки' },
    { code: 'price', name: 'Бюджет' },
    { code: 'responsible', name: 'Ответственный' },
    { code: 'tags', name: 'Теги' },
  ],
  contact: [
    { code: 'name', name: 'Имя' },
    { code: 'responsible', name: 'Ответственный' },
    { code: 'tags', name: 'Теги' },
  ],
  company: [
    { code: 'name', name: 'Название компании' },
    { code: 'responsible', name: 'Ответственный' },
    { code: 'tags', name: 'Теги' },
  ],
};

function systemFieldId(entity: EntityType, code: string): string {
  return `sys_${entity}_${code}`;
}

export interface MetaField {
  id: string;
  name: string;
  entity: EntityType;
  system?: boolean; // системное поле amoCRM (не из custom_fields)
}
export interface MetaUser {
  id: string;
  name: string;
}
export interface MetaPipeline {
  id: string;
  name: string;
}

// Настройки воронок: { pipelineId: { fieldId: mode } }.
export type FunnelsMap = Record<string, Record<string, FieldMode>>;

export interface MetaResult {
  fields: MetaField[];
  users: MetaUser[];
  pipelines: MetaPipeline[];
  matrix: Record<string, FieldMode>; // "field:user" -> mode
  funnels: FunnelsMap; // "pipeline" -> { field -> mode } (для режима V)
  groups: unknown[]; // виртуальные группы — вне MVP
}

// Формат, который ждёт resolveMode() во фронтенде: rules[fieldId][entity][pipeline] = mode.
export interface ConfigResult {
  rules: Record<string, Record<string, Record<string, FieldMode>>>;
  funnels: FunnelsMap;
}

@Injectable()
export class VisibilityService {
  constructor(
    private readonly repo: VisibilityRepository,
    private readonly amocrm: AmocrmService,
    private readonly audit: AuditService,
  ) {}

  private buildFunnels(rows: FunnelRow[]): FunnelsMap {
    const funnels: FunnelsMap = {};
    for (const r of rows) {
      (funnels[r.pipeline_id] ??= {})[r.field_id] = r.mode;
    }
    return funnels;
  }

  /** Метаданные для экрана настроек: поля, пользователи, воронки + текущая матрица и настройки воронок. */
  async getMeta(accountId: string): Promise<MetaResult> {
    requireAccountId(accountId);

    const [fieldsByEntity, users, pipelines, rows, funnelRows] = await Promise.all([
      Promise.all(ENTITIES.map((e) => this.amocrm.getCustomFields(accountId, e))),
      this.amocrm.getUsers(accountId),
      this.amocrm.getPipelines(accountId),
      this.repo.findAll(accountId),
      this.repo.findFunnels(accountId),
    ]);

    const fields: MetaField[] = [];
    ENTITIES.forEach((entity, i) => {
      // системные поля идут первыми, затем кастомные поля сущности
      for (const sf of SYSTEM_FIELDS[entity]) {
        fields.push({ id: systemFieldId(entity, sf.code), name: sf.name, entity, system: true });
      }
      for (const f of fieldsByEntity[i]) {
        fields.push({ id: String(f.id), name: f.name, entity });
      }
    });

    const matrix: Record<string, FieldMode> = {};
    for (const r of rows) matrix[`${r.field_id}:${r.user_id}`] = r.mode;

    return {
      fields,
      users: users.map((u) => ({ id: String(u.id), name: u.name })),
      pipelines: pipelines.map((p) => ({ id: String(p.id), name: p.name })),
      matrix,
      funnels: this.buildFunnels(funnelRows),
      groups: [],
    };
  }

  /**
   * Конфигурация режимов для текущего пользователя — в формате resolveMode().
   * MVP: режим применяется ко всем сущностям и воронкам → ключи '*'.
   * funnels — настройки воронок аккаунта: их наследует режим V (резолв — на фронте,
   * т.к. текущая воронка карточки известна только в браузере).
   */
  async getConfigForUser(accountId: string, userId: string): Promise<ConfigResult> {
    requireAccountId(accountId);
    if (!userId) throw new BadRequestException('user_id обязателен');

    const [rows, funnelRows] = await Promise.all([
      this.repo.findByUser(accountId, userId),
      this.repo.findFunnels(accountId),
    ]);

    const rules: ConfigResult['rules'] = {};
    for (const r of rows) {
      if (r.mode === 'O') continue;
      rules[r.field_id] = { '*': { '*': r.mode } };
    }
    return { rules, funnels: this.buildFunnels(funnelRows) };
  }

  /**
   * Полное сохранение матрицы из экрана настроек.
   * Принимает плоскую карту { "field:user": mode }; режим 'O' (по умолчанию) не хранится.
   */
  async saveMatrix(accountId: string, matrix: unknown): Promise<{ saved: number }> {
    requireAccountId(accountId);
    if (matrix === null || typeof matrix !== 'object') {
      throw new BadRequestException('matrix должен быть объектом { "field:user": mode }');
    }

    const rows: MatrixRow[] = [];
    for (const [key, raw] of Object.entries(matrix as Record<string, unknown>)) {
      const mode = String(raw) as FieldMode;
      if (!MODES.includes(mode) || mode === 'O') continue; // 'O' = по умолчанию, не храним
      const sep = key.lastIndexOf(':');
      if (sep <= 0) continue;
      const fieldId = key.slice(0, sep);
      const userId = key.slice(sep + 1);
      if (!fieldId || !/^\d+$/.test(userId)) continue;
      rows.push({ field_id: fieldId, user_id: userId, mode });
    }

    await this.repo.replaceAll(accountId, rows);
    await this.audit.log({ accountId, action: 'matrix_save', meta: { saved: rows.length } });
    return { saved: rows.length };
  }

  /**
   * Полное сохранение настроек воронок (для режима V).
   * Принимает плоскую карту { "pipeline:field": mode }; допустимы режимы S, * и B.
   */
  async saveFunnels(accountId: string, funnels: unknown): Promise<{ saved: number }> {
    requireAccountId(accountId);
    if (funnels === null || typeof funnels !== 'object') {
      throw new BadRequestException('funnels должен быть объектом { "pipeline:field": mode }');
    }

    const rows: FunnelRow[] = [];
    for (const [key, raw] of Object.entries(funnels as Record<string, unknown>)) {
      const mode = String(raw) as FieldMode;
      if (!FUNNEL_MODES.includes(mode)) continue; // только S/*/B (без O и V)
      const sep = key.indexOf(':'); // pipeline_id числовой (без ':') → делим по первому
      if (sep <= 0) continue;
      const pipelineId = key.slice(0, sep);
      const fieldId = key.slice(sep + 1);
      if (!/^\d+$/.test(pipelineId) || !fieldId) continue;
      rows.push({ pipeline_id: pipelineId, field_id: fieldId, mode });
    }

    await this.repo.replaceFunnels(accountId, rows);
    await this.audit.log({
      accountId,
      action: 'matrix_save',
      meta: { op: 'funnels', saved: rows.length },
    });
    return { saved: rows.length };
  }
}
