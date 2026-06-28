import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, createActor, Snapshot } from 'xstate';
import {
  AuthMachineContext,
  createAuthMachine,
  EnrollPhoneInput,
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

  private readonly sessions = new Map<string, Actor<AuthActor>>();

  async onModuleInit() {
    await this.restoreSessions();
  }

  public getSessionState(sessionId: string) {
    const actor = this.sessions.get(sessionId);
    if (!actor) return null;
    return actor.getSnapshot();
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

          await this.datasource.transaction(async (manager) => {
            const fsmRepository = manager.getRepository(FSM);

            const machine = await fsmRepository.findOne({
              where: { sessionId: entry.sessionId },
              lock: { mode: 'pessimistic_write' },
            });

            if (!machine) throw new NotFoundException();

            machine.phoneId = result.value.phone_id;
            await fsmRepository.save(machine);
          });
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

  private subscribeToActor(sessionId: string, actor: Actor<AuthActor>): void {
    actor.subscribe((snapshot) => {
      this.datasource
        .getRepository(FSM)
        .upsert({ sessionId, snapshot: snapshot.toJSON() as object }, [
          'sessionId',
        ])
        .catch((err) =>
          console.error(`Failed to persist snapshot for ${sessionId}:`, err),
        );
    });
  }

  public sendMagicLink = async (email: string) => {
    const sessionId = crypto.randomUUID();
    await this.createStateMachine(sessionId, email);
    return { sessionId };
  };

  public sendMagicLinkActor = async ({
    sessionId,
    email,
  }: SendMagicLinkInput) => {
    await this.datasource.transaction(async (manager) => {
      const outboxRepository = manager.getRepository(MagicLinkOutbox);

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
    });
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

    this.sendChecked(actor, {
      type: 'received_magic_link',
      token,
    });

    await new Promise<void>((resolve, reject) => {
      const sub = actor.subscribe((snapshot) => {
        if (snapshot.matches({ processing_sms_otp: 'waiting' })) {
          sub.unsubscribe();
          resolve();
        } else if (
          snapshot.matches({ processing_phone_enrollment: 'waiting' })
        ) {
          sub.unsubscribe();
          resolve();
        } else if (snapshot.matches('error')) {
          sub.unsubscribe();
          reject(new Error('Magic link processing failed'));
        }
      });

      actor.send({ type: 'received_magic_link', token });
    });
  }

  public processMagicLinkActor = async ({
    sessionId,
    token,
  }: ProcessMagicLinkInput): Promise<ProcessMagicLinkOutput> => {
    return await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      if (!machine.processedMagicLink) {
        const result = await this.stytch.magicLinks.authenticate({
          token,
          session_duration_minutes: 10,
        });

        machine.stytchUser = result.user;
        machine.intermediarySessionToken = result.session_token;
        machine.processedMagicLink = true;
        await machineRepository.save(machine);
      }

      return {
        hasPhone: (machine.stytchUser?.phone_numbers?.length ?? 0) > 0,
      };
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

    this.sendChecked(actor, {
      type: 'received_phone_number',
      phoneNumber,
    });

    await new Promise<void>((resolve, reject) => {
      const sub = actor.subscribe((snapshot) => {
        if (snapshot.matches({ processing_sms_otp: 'waiting' })) {
          sub.unsubscribe();
          resolve();
        } else if (snapshot.matches('error')) {
          sub.unsubscribe();
          reject(new Error('Phone enrollment failed'));
        }
      });

      actor.send({ type: 'received_phone_number', phoneNumber });
    });
  }

  public enrollPhoneActor = async ({
    sessionId,
    phoneNumber,
  }: EnrollPhoneInput): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      machine.enrollPhoneNumber = phoneNumber;
      await machineRepository.save(machine);
    });
  };

  public sendOTPSMSActor = async ({
    sessionId,
  }: SendOTPSMSInput): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);
      const outboxRepository = manager.getRepository(SMSOTPOutbox);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      const phoneNumber =
        machine.enrollPhoneNumber ??
        machine.stytchUser?.phone_numbers?.[0]?.phone_number;

      if (!phoneNumber)
        throw new Error(`No phone number found for sessionId: ${sessionId}`);

      const existing = await outboxRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!existing) {
        const outboxMessage = outboxRepository.create({
          phoneNumber,
          sessionId,
          sessionToken: machine.intermediarySessionToken!,
          status: OutboxStatus.PENDING,
        });

        await outboxRepository.save(outboxMessage);
      }
    });
  };

  public async submitOtp({
    sessionId,
    code,
  }: {
    sessionId: string;
    code: string;
  }): Promise<{ sessionToken: string }> {
    const actor = this.sessions.get(sessionId);
    if (!actor) throw new Error(`No session found for sessionId: ${sessionId}`);

    this.sendChecked(actor, {
      type: 'received_otp',
      code,
    });

    await new Promise<void>((resolve, reject) => {
      const sub = actor.subscribe((snapshot) => {
        if (snapshot.matches('complete')) {
          sub.unsubscribe();
          resolve();
        } else if (snapshot.matches('error')) {
          sub.unsubscribe();
          reject(new Error('OTP validation failed'));
        }
      });
      actor.send({ type: 'received_otp', code });
    });

    const sessionToken = await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();

      return machine.sessionToken;
    });

    return { sessionToken: sessionToken! };
  }

  public processSMSOtpActor = async ({
    sessionId,
    code,
  }: ProcessSMSOtpInput): Promise<void> => {
    await this.datasource.transaction(async (manager) => {
      const machineRepository = manager.getRepository(FSM);

      const machine = await machineRepository.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!machine) throw new NotFoundException();
      if (!machine.phoneId)
        throw new Error(`No phone_id found for sessionId: ${sessionId}`);

      const result = await this.stytch.otps.authenticate({
        method_id: machine.phoneId,
        code,
        session_token: machine.intermediarySessionToken ?? undefined,
        session_duration_minutes: 60,
      });

      machine.sessionToken = result.session_token;
      await machineRepository.save(machine);
    });
  };

  public async createStateMachine(sessionId: string, email: string) {
    const machine = createAuthMachine({
      sendMagicLink: (input) => this.sendMagicLinkActor(input),
      processMagicLink: (input) => this.processMagicLinkActor(input),
      sendOTPSMS: (input) => this.sendOTPSMSActor(input),
      enrollPhone: (input) => this.enrollPhoneActor(input),
      processSMSOtp: (input) => this.processSMSOtpActor(input),
    });

    const actor = createActor(machine, {
      input: { sessionId, email },
    });

    this.subscribeToActor(sessionId, actor);
    actor.start();
    this.sessions.set(sessionId, actor);
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
        sendMagicLink: (input) => this.sendMagicLinkActor(input),
        processMagicLink: (input) => this.processMagicLinkActor(input),
        sendOTPSMS: (input) => this.sendOTPSMSActor(input),
        enrollPhone: (input) => this.enrollPhoneActor(input),
        processSMSOtp: (input) => this.processSMSOtpActor(input),
      });

      const actor = createActor(machine, {
        input: { sessionId: context.sessionId, email: context.email },
        snapshot,
      });

      this.subscribeToActor(record.sessionId, actor);
      actor.start();
      this.sessions.set(record.sessionId, actor);
    }

    console.log(`Restored ${records.length} sessions from database`);
  }

  private sendChecked(actor: Actor<AuthActor>, event: any): void {
    const snapshot = actor.getSnapshot();

    if (!snapshot.can(event)) {
      throw new ConflictException(
        `Cannot process '${event.type}' from state ${JSON.stringify(snapshot.value)}`,
      );
    }

    actor.send(event);
  }
}
