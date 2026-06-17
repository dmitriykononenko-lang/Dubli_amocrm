import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

// ApiAuthModule реэкспортирует AccountsModule → AccountsService доступен SettingsService.
@Module({
  imports: [ApiAuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
