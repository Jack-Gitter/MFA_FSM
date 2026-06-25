import { Module } from '@nestjs/common';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './types/constants';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STYTCH_CLIENT,
      useFactory: (config: ConfigService) =>
        new stytch.Client({
          project_id: config.getOrThrow('STYTCH_PROJECT_ID'),
          secret: config.getOrThrow('STYTCH_SECRET'),
        }),
      inject: [ConfigService],
    },
  ],
  exports: [STYTCH_CLIENT],
})
export class StytchModule {}
