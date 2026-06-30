import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { transition } from 'xstate';
import { authMachine, AuthState } from './auth.machine';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './stytch/types/constants';
import { FSM } from './db/entities/fsm.entity';
import {
  MagicLinkOutbox,
  OutboxStatus,
} from './db/entities/email-outbox.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SMSOTPOutbox } from './db/entities/sms-outbox.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  public async createSession(email: string): Promise<{ sessionId: string }> {
    const sessionId = crypto.randomUUID();

    await this.datasource.transaction(async (manager) => {
      await manager.getRepository(FSM).save(
        manager.getRepository(FSM).create({
          sessionId,
          email,
          state: 'awaiting_magic_link',
        }),
      );

      const outboxRepo = manager.getRepository(MagicLinkOutbox);
      await outboxRepo.save(
        outboxRepo.create({ email, sessionId, status: OutboxStatus.PENDING }),
      );
    });

    return { sessionId };
  }

  public async handleMagicLink(
    sessionId: string,
    token: string,
  ): Promise<void> {
    await this.datasource.transaction(async (manager) => {
      const repo = manager.getRepository(FSM);
      const fsm = await repo.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!fsm) throw new NotFoundException(`No session found: ${sessionId}`);

      const snapshot = authMachine.resolveState({
        value: fsm.state,
        context: {},
      });

      if (
        !snapshot.can({ type: 'magic_link_verified', hasPhone: true }) ||
        !snapshot.can({ type: 'magic_link_verified', hasPhone: false })
      ) {
        throw new ConflictException(
          `Cannot verify magic link from state '${fsm.state}'`,
        );
      }

      if (!fsm.processedMagicLink) {
        const result = await this.stytch.magicLinks.authenticate({
          token,
          session_duration_minutes: 10,
        });
        fsm.stytchUser = result.user;
        fsm.intermediarySessionToken = result.session_token;
        fsm.processedMagicLink = true;
      }

      const hasPhone = (fsm.stytchUser?.phone_numbers?.length ?? 0) > 0;

      const nextState = transition(authMachine, snapshot, {
        type: 'magic_link_verified',
        hasPhone,
      })[0].value as AuthState;

      if (nextState === 'awaiting_otp') {
        await this.enqueueSms(manager, fsm);
      }

      fsm.state = nextState;
      await repo.save(fsm);
    });
  }

  public async enrollPhone(
    sessionId: string,
    phoneNumber: string,
  ): Promise<void> {
    await this.datasource.transaction(async (manager) => {
      const repo = manager.getRepository(FSM);
      const fsm = await repo.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!fsm) throw new NotFoundException(`No session found: ${sessionId}`);

      const event = { type: 'phone_enrolled', phoneNumber } as const;
      const snapshot = authMachine.resolveState({
        value: fsm.state,
        context: {},
      });

      if (!snapshot.can(event)) {
        throw new ConflictException(
          `Cannot '${event.type}' from state '${fsm.state}'`,
        );
      }

      const nextState = transition(authMachine, snapshot, event)[0]
        .value as AuthState;

      fsm.enrollPhoneNumber = phoneNumber;
      await this.enqueueSms(manager, fsm);

      fsm.state = nextState;
      await repo.save(fsm);
    });
  }

  public async submitOtp(sessionId: string, code: string): Promise<void> {
    await this.datasource.transaction(async (manager) => {
      const repo = manager.getRepository(FSM);
      const fsm = await repo.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!fsm) throw new NotFoundException(`No session found: ${sessionId}`);

      const event = { type: 'otp_verified' } as const;
      const snapshot = authMachine.resolveState({
        value: fsm.state,
        context: {},
      });

      if (!snapshot.can(event)) {
        throw new ConflictException(
          `Cannot verify OTP from state '${fsm.state}'`,
        );
      }

      if (!fsm.sessionToken) {
        if (!fsm.phoneId) {
          throw new BadRequestException('OTP has not been sent yet');
        }

        const result = await this.stytch.otps.authenticate({
          method_id: fsm.phoneId,
          code,
          session_token: fsm.intermediarySessionToken ?? undefined,
          session_duration_minutes: 60,
        });
        fsm.sessionToken = result.session_token;
      }

      const nextState = transition(authMachine, snapshot, event)[0]
        .value as AuthState;

      fsm.state = nextState;
      await repo.save(fsm);
    });
  }

  private async enqueueSms(manager: EntityManager, fsm: FSM): Promise<void> {
    const phoneNumber =
      fsm.enrollPhoneNumber ?? fsm.stytchUser?.phone_numbers?.[0]?.phone_number;

    if (!phoneNumber)
      throw new BadRequestException(
        `No phone number on file for ${fsm.sessionId}`,
      );

    if (!fsm.intermediarySessionToken)
      throw new BadRequestException(
        `Session ${fsm.sessionId} not authenticated`,
      );

    const repo = manager.getRepository(SMSOTPOutbox);
    const existing = await repo.findOne({
      where: { sessionId: fsm.sessionId },
    });

    if (existing) return;

    await repo.save(
      repo.create({
        sessionId: fsm.sessionId,
        phoneNumber,
        sessionToken: fsm.intermediarySessionToken,
        status: OutboxStatus.PENDING,
      }),
    );
  }

  public async getStatus(
    sessionId: string,
  ): Promise<{ state: string; sessionToken: string | null } | null> {
    const fsm = await this.datasource
      .getRepository(FSM)
      .findOne({ where: { sessionId } });
    if (!fsm) return null;
    return { state: fsm.state, sessionToken: fsm.sessionToken };
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  public async pollOutbox(): Promise<void> {
    const repo = this.datasource.getRepository(MagicLinkOutbox);

    const pending = await repo.find({
      where: { status: OutboxStatus.PENDING },
      order: { createdAt: 'ASC' },
    });

    const results = await Promise.allSettled(
      pending.map((entry) =>
        this.stytch.magicLinks.email.loginOrCreate({
          email: entry.email,
          login_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
          signup_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
        }),
      ),
    );

    await Promise.all(
      results.map((result, i) => {
        const entry = pending[i];
        if (result.status === 'fulfilled') {
          entry.status = OutboxStatus.SENT;
        } else {
          console.error(
            `Failed to send magic link to ${entry.email}:`,
            result.reason,
          );
          entry.status = OutboxStatus.FAILED;
        }
        return repo.save(entry);
      }),
    );
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  public async pollSMSOTPOutbox(): Promise<void> {
    const repo = this.datasource.getRepository(SMSOTPOutbox);

    const pending = await repo.find({
      where: { status: OutboxStatus.PENDING },
      order: { createdAt: 'ASC' },
    });

    const results = await Promise.allSettled(
      pending.map((entry) =>
        this.stytch.otps.sms.send({
          phone_number: entry.phoneNumber,
          session_token: entry.sessionToken,
        }),
      ),
    );

    await Promise.all(
      results.map(async (result, i) => {
        const entry = pending[i];
        if (result.status === 'fulfilled') {
          entry.status = OutboxStatus.SENT;
          try {
            await this.datasource.transaction(async (manager) => {
              const repo = manager.getRepository(FSM);
              const fsm = await repo.findOne({
                where: { sessionId: entry.sessionId },
                lock: { mode: 'pessimistic_write' },
              });
              if (!fsm) return;
              fsm.phoneId = result.value.phone_id;
              await repo.save(fsm);
            });
          } catch (err) {
            console.error(
              `Failed to persist phone_id for ${entry.sessionId}:`,
              err,
            );
          }
        } else {
          console.error(
            `Failed to send OTP SMS to ${entry.phoneNumber}:`,
            result.reason,
          );
          entry.status = OutboxStatus.FAILED;
        }
        return repo.save(entry);
      }),
    );
  }
}
