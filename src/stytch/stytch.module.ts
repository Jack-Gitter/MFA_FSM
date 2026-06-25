import { Module } from '@nestjs/common';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './stytch.constants';

@Module({
  providers: [
    {
      provide: STYTCH_CLIENT,
      useFactory: () =>
        new stytch.Client({
          project_id: process.env.STYTCH_PROJECT_ID!,
          secret: process.env.STYTCH_SECRET!,
        }),
    },
  ],
  exports: [STYTCH_CLIENT],
})
export class StytchModule {}
