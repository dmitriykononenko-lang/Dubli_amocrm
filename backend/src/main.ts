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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: levelsFor(process.env.LOG_LEVEL ?? 'log'),
  });

  app.use(helmet());
  // amoCRM присылает вебхуки как application/x-www-form-urlencoded c вложенными массивами.
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.use(json({ limit: '1mb' }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`Dubli backend слушает порт ${config.port}`);
}

void bootstrap();
