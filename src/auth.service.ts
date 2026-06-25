import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, AnyActorRef, createActor } from 'xstate';
import {
  createAuthMachine,
  MintSessionInput,
  SendMagicLinkInput,
  SendOTPSMSInput,
  ValidateMagicLinkInput,
  ValidateOTPSMSInput,
} from './auth.machine';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './stytch/types/constants';
import { FSM } from './db/entities/fsm.entity';
import {
  MagicLinkOutbox,
  OutboxStatus,
} from './db/entities/email-outbox.entity';
import { Cron, CronExpression } from '@nestjs/schedule';

type AuthActor = ReturnType<typeof createAuthMachine>;

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  private readonly sessions = new Map<string, Actor<AuthActor>>();

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
          console.log('sent outbox message!');
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

  public sendMagicLink = async (email: string) => {
    const sessionId = crypto.randomUUID();
    const actor = this.createStateMachine(email);

    actor.start();
    this.sessions.set(sessionId, actor);

    return { sessionId };
  };

  public sendMagicLinkActor = async (
    { email }: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => {
    await this.datasource.transaction(async (manager) => {
      const outbox = new MagicLinkOutbox();
      outbox.email = email;
      await manager.save(outbox);

      const machine = new FSM();
      machine.lastTransition = {
        prev: 'sending_magic_link',
        current: 'awaiting_magic_link',
      };
      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await manager.save(machine);
    });
  };

  public validateMagicLinkActor = async (_input: ValidateMagicLinkInput) => {
    throw new Error('not implemented');
  };

  public sendOTPSMSActor = async (_input: SendOTPSMSInput) => {
    throw new Error('not implemented');
  };

  public validateOTPSMSActor = async (_input: ValidateOTPSMSInput) => {
    throw new Error('not implemented');
  };

  public mintSessionActor = async (_input: MintSessionInput) => {
    throw new Error('not implemented');
  };

  public createStateMachine(email: string) {
    const machine = createAuthMachine({
      sendMagicLink: (input, parent) => this.sendMagicLinkActor(input, parent),
      validateMagicLink: (input) => this.validateMagicLinkActor(input),
      sendOTPSMS: (input) => this.sendOTPSMSActor(input),
      validateOTPSMS: (input) => this.validateOTPSMSActor(input),
      mintSession: (input) => this.mintSessionActor(input),
    });

    return createActor(machine, {
      input: { email },
    });
  }
}
