import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, AnyActorRef, createActor, Snapshot } from 'xstate';
import {
  AuthMachineContext,
  createAuthMachine,
  EnrollPhoneInput,
  MintSessionInput,
  ProcessMagicLinkInput,
  ProcessMagicLinkOutput,
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
import { SMSOTPOutbox } from './db/entities/sms-outbox.entity';

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
          console.log('sent sms otp!');

          await this.datasource
            .getRepository(FSM)
            .update(
              { sessionId: entry.sessionId },
              { phoneId: result.value.phone_id },
            );
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

  public sendMagicLink = async (email: string) => {
    const sessionId = crypto.randomUUID();
    await this.createStateMachine(sessionId, email);

    return { sessionId };
  };

  public sendMagicLinkActor = async (
    { sessionId, email }: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => {
    await this.datasource.transaction(async (manager) => {
      const outboxRepository = manager.getRepository(MagicLinkOutbox);
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

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

      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await manager.save(machine);
    });
  };

  public async handleMagicLink({
    sessionId,
    token,
  }: {
    sessionId: string;
    token: string;
  }): Promise<{ hasPhone: boolean }> {
    const actor = this.sessions.get(sessionId);

    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }

    actor.send({ type: 'received_magic_link', token });

    const snapshot = actor.getSnapshot();
    const email = snapshot.context.email;

    const searchResult = await this.stytch.users.search({
      query: {
        operator: 'AND',
        operands: [{ filter_name: 'email_address', filter_value: [email] }],
      },
    });

    const user = searchResult.results[0];

    if (!user) throw new Error(`No Stytch user found for email: ${email}`);

    return { hasPhone: user.phone_numbers.length > 0 };
  }

  public processMagicLinkActor = async (
    { sessionId, token }: ProcessMagicLinkInput,
    parent?: AnyActorRef,
  ): Promise<ProcessMagicLinkOutput> => {
    return await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      let hasPhone = false;

      if (!machine.processedMagicLink) {
        const result = await this.stytch.magicLinks.authenticate({
          token,
          session_duration_minutes: 10,
        });

        hasPhone = result.user.phone_numbers.length > 0;
        machine.sessionToken = result.session_token;
        machine.processedMagicLink = true;
      }

      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await machineRepository.save(machine);

      return { hasPhone };
    });
  };

  public sendOTPSMSActor = async (
    { sessionId, email }: SendOTPSMSInput,
    parent?: AnyActorRef,
  ): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);
      const outboxRepository = manager.getRepository(SMSOTPOutbox);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      let phoneNumber = machine.enrollPhoneNumber;

      if (!phoneNumber) {
        const searchResult = await this.stytch.users.search({
          query: {
            operator: 'AND',
            operands: [{ filter_name: 'email_address', filter_value: [email] }],
          },
        });

        const user = searchResult.results[0];
        if (!user) throw new Error(`No Stytch user found for email: ${email}`);

        phoneNumber = user.phone_numbers?.[0]?.phone_number;
        if (!phoneNumber)
          throw new Error(`No phone number found for email: ${email}`);
      }

      const existing = await outboxRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!existing) {
        const outboxMessage = outboxRepository.create({
          phoneNumber,
          sessionId,
          sessionToken: machine.sessionToken!,
          status: OutboxStatus.PENDING,
        });

        await outboxRepository.save(outboxMessage);
      }

      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await machineRepository.save(machine);
    });
  };

  public async enrollPhone({
    sessionId,
    phoneNumber,
  }: {
    sessionId: string;
    phoneNumber: string;
  }): Promise<void> {
    const actor = this.sessions.get(sessionId);

    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }

    actor.send({ type: 'received_phone_number', phoneNumber });
  }

  public enrollPhoneActor = async (
    { sessionId, phoneNumber }: EnrollPhoneInput,
    parent?: AnyActorRef,
  ): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      machine.enrollPhoneNumber = phoneNumber;
      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await machineRepository.save(machine);
    });
  };

  public async submitOtp({
    sessionId,
    code,
  }: {
    sessionId: string;
    code: string;
  }): Promise<void> {
    const actor = this.sessions.get(sessionId);

    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }

    actor.send({ type: 'received_otp', code });
  }

  public processSMSOtpActor = async (
    { sessionId, code }: ProcessSMSOtpInput,
    parent?: AnyActorRef,
  ): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      if (!machine.phoneId)
        throw new Error(`No phone_id found for sessionId: ${sessionId}`);

      await this.stytch.otps.authenticate({
        method_id: machine.phoneId,
        code,
        session_token: machine.sessionToken ?? undefined,
        session_duration_minutes: 60,
      });

      machine.snapshot = parent?.getPersistedSnapshot() as object;
      await machineRepository.save(machine);
    });
  };

  public mintSessionActor = async (
    _input: MintSessionInput,
    _parent?: AnyActorRef,
  ): Promise<void> => {
    throw new Error('not implemented');
  };

  public async createStateMachine(sessionId: string, email: string) {
    const machine = createAuthMachine({
      sendMagicLink: (input, parent) => this.sendMagicLinkActor(input, parent),
      processMagicLink: (input, parent) =>
        this.processMagicLinkActor(input, parent),
      sendOTPSMS: (input, parent) => this.sendOTPSMSActor(input, parent),
      enrollPhone: (input, parent) => this.enrollPhoneActor(input, parent),
      processSMSOtp: (input, parent) => this.processSMSOtpActor(input, parent),
      mintSession: (input, parent) => this.mintSessionActor(input, parent),
    });

    const actor = createActor(machine, {
      input: { sessionId, email },
    });

    actor.start();
    this.sessions.set(sessionId, actor);

    const fsmRepository = this.datasource.getRepository(FSM);
    const fsm = fsmRepository.create({
      sessionId,
      snapshot: actor.getPersistedSnapshot() as object,
    });

    await fsmRepository.save(fsm);
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
        enrollPhone: (input, parent) => this.enrollPhoneActor(input, parent),
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
