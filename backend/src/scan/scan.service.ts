import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import type { EntityType, ScanStatus } from '../common/db/database.types';
import { AmocrmService } from '../amocrm/amocrm.service';
import { EntitiesService } from '../entities/entities.service';
import { AuditService } from '../common/audit/audit.service';
import { ScanJobsRepository, type ScanJob } from './scan.repository';

/** Представление задачи для API (без курсора/служебных полей). */
export interface ScanJobDto {
  id: string;
  entity_type: EntityType;
  status: ScanStatus;
  progress: number;
  total: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export interface ProcessResult {
  idle: boolean;
  jobId?: string;
  status?: ScanStatus;
  processed: number;
}

/**
 * Фоновое массовое сканирование: ставит задачи и обрабатывает их постранично
 * (одна страница amoCRM за шаг), сохраняя курсор (_links.next) для паузы/докачки.
 * Индексация переиспользует EntitiesService — те же entity_keys, что и у вебхуков.
 */
@Injectable()
export class ScanService {
  constructor(
    private readonly repo: ScanJobsRepository,
    private readonly amocrm: AmocrmService,
    private readonly entities: EntitiesService,
    private readonly audit: AuditService,
  ) {}

  async enqueue(
    accountId: string,
    entityType: EntityType,
    params: Record<string, unknown> = {},
  ): Promise<ScanJobDto> {
    requireAccountId(accountId);
    const job = await this.repo.create(accountId, entityType, params);
    await this.audit.log({
      accountId,
      action: 'scan',
      meta: { jobId: job.id, queued: true, entityType },
    });
    return toDto(job);
  }

  async get(accountId: string, id: string): Promise<ScanJobDto> {
    const job = await this.repo.findById(accountId, id);
    if (!job) throw new NotFoundException('Задача сканирования не найдена');
    return toDto(job);
  }

  async list(accountId: string): Promise<ScanJobDto[]> {
    return (await this.repo.list(accountId)).map(toDto);
  }

  async pause(accountId: string, id: string): Promise<ScanJobDto> {
    const job = await this.requireJob(accountId, id);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new BadRequestException('Приостановить можно только активную задачу');
    }
    await this.repo.update(job.id, { status: 'paused' });
    return toDto({ ...job, status: 'paused' });
  }

  async resume(accountId: string, id: string): Promise<ScanJobDto> {
    const job = await this.requireJob(accountId, id);
    if (job.status !== 'paused') {
      throw new BadRequestException('Возобновить можно только приостановленную задачу');
    }
    // cursor сохранён → задача продолжится со следующей страницы
    await this.repo.update(job.id, { status: 'queued' });
    return toDto({ ...job, status: 'queued' });
  }

  /**
   * Обрабатывает одну страницу ближайшей активной задачи. Вызывается фоновым
   * процессором по таймеру (в тестах — вручную). idle=true, если задач нет.
   */
  async processOnce(): Promise<ProcessResult> {
    const job = await this.repo.findRunnable();
    if (!job) return { idle: true, processed: 0 };

    if (job.status === 'queued') {
      await this.repo.update(job.id, { status: 'running', started_at: new Date() });
    }

    try {
      const page = await this.amocrm.listPage(job.account_id, job.entity_type, job.cursor);
      let indexed = 0;
      for (const raw of page.items) {
        const amoId = raw?.id != null ? String(raw.id) : null;
        if (!amoId) continue;
        await this.entities.indexEntity(job.account_id, job.entity_type, amoId, raw);
        indexed++;
      }
      const progress = job.progress + indexed;

      if (page.nextPath) {
        await this.repo.update(job.id, { status: 'running', progress, cursor: page.nextPath });
        return { idle: false, jobId: job.id, status: 'running', processed: indexed };
      }
      await this.repo.update(job.id, {
        status: 'done',
        progress,
        total: progress,
        cursor: null,
        finished_at: new Date(),
      });
      await this.audit.log({
        accountId: job.account_id,
        action: 'scan',
        meta: { jobId: job.id, indexed: progress, entityType: job.entity_type, done: true },
      });
      return { idle: false, jobId: job.id, status: 'done', processed: indexed };
    } catch (e) {
      await this.repo.update(job.id, { status: 'error', finished_at: new Date() });
      await this.audit.log({
        accountId: job.account_id,
        action: 'scan',
        meta: { jobId: job.id, error: (e as Error).message },
      });
      return { idle: false, jobId: job.id, status: 'error', processed: 0 };
    }
  }

  private async requireJob(accountId: string, id: string): Promise<ScanJob> {
    const job = await this.repo.findById(accountId, id);
    if (!job) throw new NotFoundException('Задача сканирования не найдена');
    return job;
  }
}

function toDto(j: ScanJob): ScanJobDto {
  return {
    id: j.id,
    entity_type: j.entity_type,
    status: j.status,
    progress: j.progress,
    total: j.total,
    started_at: j.started_at,
    finished_at: j.finished_at,
    created_at: j.created_at,
  };
}
