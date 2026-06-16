import { Module } from '@nestjs/common';
import { ApiAuthModule } from '../common/auth/api-auth.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { VisibilityController } from './visibility.controller';
import { VisibilityService } from './visibility.service';
import { VisibilityRepository } from './visibility.repository';

@Module({
  imports: [ApiAuthModule, AmocrmModule],
  controllers: [VisibilityController],
  providers: [VisibilityService, VisibilityRepository],
})
export class VisibilityModule {}
