import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ScanService } from './scan.service';

/**
 * Фоновый процессор очереди сканов: по таймеру берёт ближайшую активную задачу и
 * обрабатывает одну страницу. В тестах (NODE_ENV=test) и при SCAN_POLL_MS=0 не запускается —
 * там processOnce вызывают вручную.
 */
@Injectable()
export class ScanProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Scan');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly scan: ScanService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test' || this.config.scanPollMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.scanPollMs);
    this.timer.unref?.(); // не держим процесс ради таймера
    this.logger.log(`Фоновый сканер активен (период ${this.config.scanPollMs} мс)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Один проход; пропускаем, если предыдущий ещё выполняется (без перекрытия).
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scan.processOnce();
    } catch (e) {
      this.logger.error(`scan tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
