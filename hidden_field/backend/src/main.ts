import 'reflect-metadata';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';

// Сопоставление LOG_LEVEL → уровни логгера Nest (порог: включаем уровень и всё «строже»).
const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
function levelsFor(min: string): LogLevel[] {
  const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
  // alias trace → verbose
  const norm = (min === 'trace' ? 'verbose' : min) as LogLevel;
  const idx = order.indexOf(norm);
  return idx === -1 ? LEVELS : order.slice(idx);
}

// Виджет вызывает /api из браузера на домене amoCRM/Kommo. Аутентификация по
// security_key (не по cookie), поэтому credentials не нужны, а origin ограничиваем
// доменами amoCRM/Kommo. Запрос без Origin (curl/сервер) тоже допускаем.
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(amocrm\.(ru|com)|kommo\.com)$/i;
function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  cb(null, !origin || ALLOWED_ORIGIN.test(origin));
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: levelsFor(process.env.LOG_LEVEL ?? 'log'),
  });

  app.use(helmet());
  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Security-Key'],
    credentials: false,
    maxAge: 86400,
  });
  // amoCRM присылает вебхуки как application/x-www-form-urlencoded c вложенными массивами.
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.use(json({ limit: '1mb' }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`Hidden Field backend слушает порт ${config.port}`);
}

void bootstrap();
