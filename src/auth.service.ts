import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, AnyActorRef, createActor, Snapshot } from 'xstate';
import {
  AuthMachineContext,
  createAuthMachine,
  MintSessionInput,
  ProcessMagicLinkInput,
  ProcessSMSOtpInput,
  SendMagicLinkInput,
  SendOTPSMSInput,
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

  async onModuleInit() {
    await this.restoreSessions();
  }

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
    const actor = this.createStateMachine(sessionId, email);

    actor.start();
    this.sessions.set(sessionId, actor);

    return { sessionId };
  };

  public async handleMagicLink({
    sessionId,
    token,
  }: {
    sessionId: string;
    token: string;
  }): Promise<void> {
    const actor = this.sessions.get(sessionId);

    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }

    actor.send({ type: 'received_magic_link', token });
  }

  public sendMagicLinkActor = async (
    { sessionId, email }: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => {
    await this.datasource.transaction(async (manager) => {
      const outboxRepository = manager.getRepository(MagicLinkOutbox);
      const machineRepository = manager.getRepository(FSM);

      const row = await outboxRepository.findOne({
        where: { email, sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!row) {
        const outboxMessage = outboxRepository.create({
          email,
          sessionId,
          status: OutboxStatus.PENDING,
        });

        await outboxRepository.save(outboxMessage);
      }

      const snapshot = machineRepository.create({
        sessionId: sessionId,
        snapshot: parent?.getPersistedSnapshot() as object,
      });

      await manager.save(snapshot);
    });
  };

  public processMagicLinkActor = async (
    _input: ProcessMagicLinkInput,
    _parent?: AnyActorRef,
  ): Promise<void> => {
    throw new Error('not implemented');
  };

  public sendOTPSMSActor = async (
    _input: SendOTPSMSInput,
    _parent?: AnyActorRef,
  ): Promise<void> => {
    throw new Error('not implemented');
  };

  public processSMSOtpActor = async (
    _input: ProcessSMSOtpInput,
    _parent?: AnyActorRef,
  ): Promise<void> => {
    throw new Error('not implemented');
  };

  public mintSessionActor = async (
    _input: MintSessionInput,
    _parent?: AnyActorRef,
  ): Promise<void> => {
    throw new Error('not implemented');
  };

  public createStateMachine(sessionId: string, email: string) {
    const machine = createAuthMachine({
      sendMagicLink: (input, parent) => this.sendMagicLinkActor(input, parent),
      processMagicLink: (input, parent) =>
        this.processMagicLinkActor(input, parent),
      sendOTPSMS: (input, parent) => this.sendOTPSMSActor(input, parent),
      processSMSOtp: (input, parent) => this.processSMSOtpActor(input, parent),
      mintSession: (input, parent) => this.mintSessionActor(input, parent),
    });

    return createActor(machine, {
      input: { sessionId, email },
    });
  }

  public async restoreSessions(): Promise<void> {
    const repo = this.datasource.getRepository(FSM);

    const records = await repo
      .createQueryBuilder('fsm')
      .where(`fsm.snapshot->>'status' NOT IN (:...statuses)`, {
        statuses: ['done', 'error', 'stopped'],
      })
      .orderBy('fsm.created_at', 'DESC')
      .getMany();

    for (const record of records) {
      const snapshot = record.snapshot as Snapshot<unknown>;
      const context = (snapshot as any).context as AuthMachineContext;

      const machine = createAuthMachine({
        sendMagicLink: (input, parent) =>
          this.sendMagicLinkActor(input, parent),
        processMagicLink: (input, parent) =>
          this.processMagicLinkActor(input, parent),
        sendOTPSMS: (input, parent) => this.sendOTPSMSActor(input, parent),
        processSMSOtp: (input, parent) =>
          this.processSMSOtpActor(input, parent),
        mintSession: (input, parent) => this.mintSessionActor(input, parent),
      });

      const actor = createActor(machine, {
        input: { sessionId: context.sessionId, email: context.email },
        snapshot,
      });

      actor.start();
      this.sessions.set(record.sessionId, actor);
    }

    console.log(`Restored ${records.length} sessions from database`);
  }
}
