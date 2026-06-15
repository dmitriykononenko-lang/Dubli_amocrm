import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { EnvKmsService } from './env-kms.service';
import { KMS_SERVICE } from './kms.interface';

// @Global — KMS_SERVICE доступен всем модулям (tokens и т.д.).
@Global()
@Module({
  providers: [
    {
      provide: KMS_SERVICE,
      inject: [AppConfigService],
      // KMS_PROVIDER=selectel будет добавлен позже отдельной реализацией.
      useFactory: (config: AppConfigService): EnvKmsService =>
        new EnvKmsService(config.tokenEncKey),
    },
  ],
  exports: [KMS_SERVICE],
})
export class CryptoModule {}
