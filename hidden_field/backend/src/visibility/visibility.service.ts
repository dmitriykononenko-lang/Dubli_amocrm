import { BadRequestException, Injectable } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import { AuditService } from '../common/audit/audit.service';
import { AmocrmService } from '../amocrm/amocrm.service';
import type { EntityType, FieldMode } from '../common/db/database.types';
import { VisibilityRepository, type MatrixRow } from './visibility.repository';

const MODES: FieldMode[] = ['O', 'S', '*', 'B', 'V'];
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

export interface MetaResult {
  fields: MetaField[];
  users: MetaUser[];
  pipelines: MetaPipeline[];
  matrix: Record<string, FieldMode>; // "field:user" -> mode
  groups: unknown[]; // виртуальные группы — вне MVP
}

// Формат, который ждёт resolveMode() во фронтенде: rules[fieldId][entity][pipeline] = mode.
export interface ConfigResult {
  rules: Record<string, Record<string, Record<string, FieldMode>>>;
  funnels: Record<string, Record<string, FieldMode>>;
}

@Injectable()
export class VisibilityService {
  constructor(
    private readonly repo: VisibilityRepository,
    private readonly amocrm: AmocrmService,
    private readonly audit: AuditService,
  ) {}

  /** Метаданные для экрана настроек: поля, пользователи, воронки + текущая матрица. */
  async getMeta(accountId: string): Promise<MetaResult> {
    requireAccountId(accountId);

    const [fieldsByEntity, users, pipelines, rows] = await Promise.all([
      Promise.all(ENTITIES.map((e) => this.amocrm.getCustomFields(accountId, e))),
      this.amocrm.getUsers(accountId),
      this.amocrm.getPipelines(accountId),
      this.repo.findAll(accountId),
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
      groups: [],
    };
  }

  /**
   * Конфигурация режимов для текущего пользователя — в формате resolveMode().
   * MVP: режим применяется ко всем сущностям и воронкам → ключи '*'.
   */
  async getConfigForUser(accountId: string, userId: string): Promise<ConfigResult> {
    requireAccountId(accountId);
    if (!userId) throw new BadRequestException('user_id обязателен');
    const rows = await this.repo.findByUser(accountId, userId);
    const rules: ConfigResult['rules'] = {};
    for (const r of rows) {
      if (r.mode === 'O') continue;
      rules[r.field_id] = { '*': { '*': r.mode } };
    }
    return { rules, funnels: {} };
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
}
