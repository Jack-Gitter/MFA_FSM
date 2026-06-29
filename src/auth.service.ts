import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, createActor, Snapshot } from 'xstate';
import {
  AuthMachineContext,
  createAuthMachine,
  EnrollPhoneInput,
  EnrollPhoneOutput,
  ProcessMagicLinkInput,
  ProcessMagicLinkOutput,
  ProcessSMSOtpInput,
  ProcessSMSOtpOutput,
  SendMagicLinkInput,
  SendMagicLinkOutput,
  SendOTPSMSInput,
  SendOTPSMSOutput,
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

const MAX_FAILURES = 3;

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  private readonly sessions = new Map<string, Actor<AuthActor>>();
  private readonly failureCounts = new Map<string, number>();

  async onModuleInit() {
    await this.restoreSessions();
  }

  public getSessionState(sessionId: string) {
    const actor = this.sessions.get(sessionId);
    if (!actor) return null;
    return actor.getSnapshot();
  }
  public async getSessionToken(sessionId: string): Promise<string> {
    const machine = await this.datasource.getRepository(FSM).findOne({
      where: { sessionId },
    });

    if (!machine?.sessionToken) {
      throw new NotFoundException('Session token not found');
    }

    return machine.sessionToken;
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

  private async restoreSession(sessionId: string): Promise<void> {
    const repo = this.datasource.getRepository(FSM);
    const record = await repo.findOne({ where: { sessionId } });
    if (!record) return;

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

    this.subscribeToActor(sessionId, actor);
    actor.start();
    this.sessions.set(sessionId, actor);
  }

  private subscribeToActor(sessionId: string, actor: Actor<AuthActor>): void {
    actor.subscribe(async (snapshot) => {
      const { pendingWrites } = snapshot.context;

      if (
        !pendingWrites.fsm &&
        !pendingWrites.magicLinkOutbox &&
        !pendingWrites.smsOutbox
      ) {
        return;
      }

      try {
        await this.datasource.transaction(async (manager) => {
          if (pendingWrites.fsm) {
            const fsmRepository = manager.getRepository(FSM);
            const machine = await fsmRepository.findOne({
              where: { sessionId },
              lock: { mode: 'pessimistic_write' },
            });

            if (machine) {
              Object.assign(machine, pendingWrites.fsm);
              await fsmRepository.save(machine);
            } else {
              const newMachine = fsmRepository.create({
                sessionId,
                ...pendingWrites.fsm,
              });
              await fsmRepository.save(newMachine);
            }
          }

          if (pendingWrites.magicLinkOutbox) {
            const outboxRepository = manager.getRepository(MagicLinkOutbox);
            const existing = await outboxRepository.findOne({
              where: { sessionId },
              lock: { mode: 'pessimistic_write' },
            });

            if (!existing) {
              const outboxMessage = outboxRepository.create(
                pendingWrites.magicLinkOutbox,
              );
              await outboxRepository.save(outboxMessage);
            }
          }

          if (pendingWrites.smsOutbox) {
            const outboxRepository = manager.getRepository(SMSOTPOutbox);
            const existing = await outboxRepository.findOne({
              where: { sessionId },
              lock: { mode: 'pessimistic_write' },
            });

            if (!existing) {
              const outboxMessage = outboxRepository.create(
                pendingWrites.smsOutbox,
              );
              await outboxRepository.save(outboxMessage);
            }
          }
        });

        this.failureCounts.delete(sessionId);
      } catch (err) {
        console.error(`Failed to persist snapshot for ${sessionId}:`, err);

        const failures = (this.failureCounts.get(sessionId) ?? 0) + 1;
        this.failureCounts.set(sessionId, failures);

        actor.stop();
        this.sessions.delete(sessionId);

        if (failures >= MAX_FAILURES) {
          console.error(
            `Session ${sessionId} has failed ${failures} times, giving up`,
          );
          this.failureCounts.delete(sessionId);
          return;
        }

        await this.restoreSession(sessionId);
      }
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
  }: SendMagicLinkInput): Promise<SendMagicLinkOutput> => {
    return {
      magicLinkOutbox: {
        email,
        sessionId,
        status: OutboxStatus.PENDING,
      },
    };
  };

  public handleMagicLink({
    sessionId,
    token,
  }: {
    sessionId: string;
    token: string;
  }): void {
    const actor = this.sessions.get(sessionId);
    if (!actor) throw new Error(`No session found for sessionId: ${sessionId}`);
    actor.send({ type: 'received_magic_link', token });
  }

  public processMagicLinkActor = async ({
    sessionId,
    token,
  }: ProcessMagicLinkInput): Promise<ProcessMagicLinkOutput> => {
    const result = await this.stytch.magicLinks.authenticate({
      token,
      session_duration_minutes: 10,
    });

    const hasPhone = (result.user.phone_numbers?.length ?? 0) > 0;

    return {
      hasPhone,
      fsm: {
        stytchUser: result.user,
        intermediarySessionToken: result.session_token,
        processedMagicLink: true,
      },
    };
  };

  public async enrollPhone({
    sessionId,
    phoneNumber,
  }: {
    sessionId: string;
    phoneNumber: string;
  }): Promise<void> {
    const actor = this.sessions.get(sessionId);
    if (!actor) throw new Error(`No session found for sessionId: ${sessionId}`);

    const snapshot = actor.getSnapshot();
    if (!snapshot.matches({ processing_phone_enrollment: 'waiting' })) {
      throw new BadRequestException('Not in phone enrollment state');
    }

    actor.send({ type: 'received_phone_number', phoneNumber });
  }

  public enrollPhoneActor = async ({
    phoneNumber,
  }: EnrollPhoneInput): Promise<EnrollPhoneOutput> => {
    return {
      fsm: {
        enrollPhoneNumber: phoneNumber,
      },
    };
  };

  public sendOTPSMSActor = async ({
    sessionId,
  }: SendOTPSMSInput): Promise<SendOTPSMSOutput> => {
    const machine = await this.datasource.getRepository(FSM).findOne({
      where: { sessionId },
    });

    if (!machine) throw new NotFoundException();

    const phoneNumber =
      machine.enrollPhoneNumber ??
      machine.stytchUser?.phone_numbers?.[0]?.phone_number;

    if (!phoneNumber)
      throw new Error(`No phone number found for sessionId: ${sessionId}`);

    return {
      smsOutbox: {
        phoneNumber,
        sessionId,
        sessionToken: machine.intermediarySessionToken!,
        status: OutboxStatus.PENDING,
      },
    };
  };

  public async submitOtp({
    sessionId,
    code,
  }: {
    sessionId: string;
    code: string;
  }): Promise<void> {
    const actor = this.sessions.get(sessionId);
    if (!actor) throw new Error(`No session found for sessionId: ${sessionId}`);

    const snapshot = actor.getSnapshot();
    if (!snapshot.matches({ processing_sms_otp: 'waiting' })) {
      throw new BadRequestException('Not in OTP verification state');
    }

    actor.send({ type: 'received_otp', code });
  }

  public processSMSOtpActor = async ({
    sessionId,
    code,
  }: ProcessSMSOtpInput): Promise<ProcessSMSOtpOutput> => {
    const machine = await this.datasource.getRepository(FSM).findOne({
      where: { sessionId },
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

    return {
      fsm: {
        sessionToken: result.session_token,
      },
    };
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
      await this.restoreSession(record.sessionId);
    }

    console.log(`Restored ${records.length} sessions from database`);
  }
}
