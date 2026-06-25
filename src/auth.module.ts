import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FSM } from './db/entities/fsm.entity';
import { ConfigModule } from '@nestjs/config';
import { StytchModule } from './stytch/stytch.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5433,
      username: 'postgres',
      password: 'postgres',
      database: 'mfa_fsm',
      entities: [FSM],
      synchronize: true,
    }),
    StytchModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
