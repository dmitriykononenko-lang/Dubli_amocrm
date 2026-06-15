import { Module } from '@nestjs/common';
import { AmocrmHttpClient } from './amocrm-http.client';

// Лист графа модулей: без зависимостей от БД/tokens — разрывает потенциальный цикл DI.
@Module({
  providers: [AmocrmHttpClient],
  exports: [AmocrmHttpClient],
})
export class AmocrmHttpModule {}
