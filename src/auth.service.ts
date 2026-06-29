import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, AnyMachineSnapshot, createActor } from 'xstate';
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

type AuthMachine = ReturnType<typeof createAuthMachine>;
type AuthActor = Actor<AuthMachine>;

// Retry the persistence transaction this many times with the same in-memory
// data before treating it as a hard failure.
const MAX_TX_RETRIES = 3;
// How many times we will roll an actor back to its last-known-good snapshot
// before giving up and marking the session as failed (infinite-loop guard).
const MAX_RESTORES = 2;

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  private readonly sessions = new Map<string, AuthActor>();
  // Last snapshot that was successfully committed to the database, per session.
  private readonly lastGood = new Map<string, AnyMachineSnapshot>();
  // Per-session promise chain so async persistence runs serially, in order.
  private readonly persistQueue = new Map<string, Promise<void>>();
  // How many times we have rolled a session back since its last good commit.
  private readonly restoreCount = new Map<string, number>();
  // Sessions that exhausted their restore budget; reported as 'error'.
  private readonly failed = new Set<string>();

  async onModuleInit() {
    await this.restoreSessions();
  }

  // ---------------------------------------------------------------------------
  // Actors — pure, in-memory only. They never touch the database; they return
  // the data to be assigned into the machine context, which the subscribe
  // handler persists transactionally alongside the snapshot.
  // ---------------------------------------------------------------------------

  public sendMagicLinkActor = async ({
    sessionId,
    email,
  }: SendMagicLinkInput): Promise<SendMagicLinkOutput> => {
    return { magicLinkOutbox: { sessionId, email } };
  };

  public processMagicLinkActor = async ({
    token,
    processedMagicLink,
    stytchUser,
    intermediarySessionToken,
  }: ProcessMagicLinkInput): Promise<ProcessMagicLinkOutput> => {
    // Idempotency guard: if a restore re-runs this step, do not re-consume the
    // (single-use) magic link token — reuse what we already authenticated.
    if (processedMagicLink && stytchUser && intermediarySessionToken) {
      return { stytchUser, intermediarySessionToken };
    }

    const result = await this.stytch.magicLinks.authenticate({
      token,
      session_duration_minutes: 10,
    });

    return {
      stytchUser: result.user,
      intermediarySessionToken: result.session_token,
    };
  };

  public enrollPhoneActor = async ({
    phoneNumber,
  }: EnrollPhoneInput): Promise<EnrollPhoneOutput> => {
    return { enrollPhoneNumber: phoneNumber };
  };

  public sendOTPSMSActor = async ({
    sessionId,
    enrollPhoneNumber,
    stytchUser,
    intermediarySessionToken,
  }: SendOTPSMSInput): Promise<SendOTPSMSOutput> => {
    const phoneNumber =
      enrollPhoneNumber ?? stytchUser?.phone_numbers?.[0]?.phone_number;

    if (!phoneNumber)
      throw new Error(`No phone number found for sessionId: ${sessionId}`);

    if (!intermediarySessionToken)
      throw new Error(
        `No intermediary session token found for sessionId: ${sessionId}`,
      );

    return {
      smsOtpOutbox: {
        sessionId,
        phoneNumber,
        sessionToken: intermediarySessionToken,
      },
    };
  };

  public processSMSOtpActor = async ({
    sessionId,
    code,
    phoneId,
    intermediarySessionToken,
    sessionToken,
  }: ProcessSMSOtpInput): Promise<ProcessSMSOtpOutput> => {
    // Idempotency guard: a restore must not re-consume the OTP.
    if (sessionToken) return { sessionToken };

    if (!phoneId)
      throw new Error(`No phone_id found for sessionId: ${sessionId}`);

    const result = await this.stytch.otps.authenticate({
      method_id: phoneId,
      code,
      session_token: intermediarySessionToken ?? undefined,
      session_duration_minutes: 60,
    });

    return { sessionToken: result.session_token };
  };

  // ---------------------------------------------------------------------------
  // Transactional persistence — the single point where in-memory state hits the
  // database. One transaction commits the snapshot + the context-derived
  // entities together.
  // ---------------------------------------------------------------------------

  private enqueuePersist(
    sessionId: string,
    snapshot: AnyMachineSnapshot,
  ): void {
    const prev = this.persistQueue.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.persistWithRetry(sessionId, snapshot));
    this.persistQueue.set(sessionId, next);
  }

  private async persistWithRetry(
    sessionId: string,
    snapshot: AnyMachineSnapshot,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_TX_RETRIES; attempt++) {
      try {
        await this.persistOnce(sessionId, snapshot);
        this.lastGood.set(sessionId, snapshot);
        this.restoreCount.set(sessionId, 0);
        return;
      } catch (err) {
        console.error(
          `Persist attempt ${attempt}/${MAX_TX_RETRIES} failed for ${sessionId}:`,
          err,
        );
        if (attempt === MAX_TX_RETRIES) {
          this.handlePersistFailure(sessionId);
        }
      }
    }
  }

  private async persistOnce(
    sessionId: string,
    snapshot: AnyMachineSnapshot,
  ): Promise<void> {
    const ctx = snapshot.context as AuthMachineContext;

    await this.datasource.transaction(async (manager) => {
      await manager.getRepository(FSM).upsert(
        {
          sessionId,
          snapshot: snapshot.toJSON() as object,
          processedMagicLink: ctx.processedMagicLink,
          enrollPhoneNumber: ctx.enrollPhoneNumber,
          intermediarySessionToken: ctx.intermediarySessionToken,
          stytchUser: ctx.stytchUser,
          sessionToken: ctx.sessionToken,
          phoneId: ctx.phoneId,
        },
        ['sessionId'],
      );

      // Outbox rows are inserted once and keyed by a unique session_id, so
      // re-persisting is a no-op and never clobbers the cron's status updates.
      if (ctx.magicLinkOutbox) {
        await manager
          .getRepository(MagicLinkOutbox)
          .createQueryBuilder()
          .insert()
          .values({
            email: ctx.magicLinkOutbox.email,
            sessionId: ctx.magicLinkOutbox.sessionId,
            status: OutboxStatus.PENDING,
          })
          .orIgnore()
          .execute();
      }

      if (ctx.smsOtpOutbox) {
        await manager
          .getRepository(SMSOTPOutbox)
          .createQueryBuilder()
          .insert()
          .values({
            phoneNumber: ctx.smsOtpOutbox.phoneNumber,
            sessionId: ctx.smsOtpOutbox.sessionId,
            sessionToken: ctx.smsOtpOutbox.sessionToken,
            status: OutboxStatus.PENDING,
          })
          .orIgnore()
          .execute();
      }
    });
  }

  private handlePersistFailure(sessionId: string): void {
    const count = (this.restoreCount.get(sessionId) ?? 0) + 1;
    this.restoreCount.set(sessionId, count);

    // Stop the diverged actor — its in-memory state is ahead of the database.
    this.sessions.get(sessionId)?.stop();
    this.sessions.delete(sessionId);

    const lastGood = this.lastGood.get(sessionId);

    if (!lastGood || count > MAX_RESTORES) {
      console.error(
        `Giving up on session ${sessionId} after ${count} restore(s); marking as failed.`,
      );
      this.failed.add(sessionId);
      return;
    }

    console.warn(
      `Restoring session ${sessionId} to last known good state (restore #${count}).`,
    );
    this.spawnActor(sessionId, { snapshot: lastGood });
  }

  // ---------------------------------------------------------------------------
  // Actor lifecycle
  // ---------------------------------------------------------------------------

  private buildMachine(): AuthMachine {
    return createAuthMachine({
      sendMagicLink: (input) => this.sendMagicLinkActor(input),
      processMagicLink: (input) => this.processMagicLinkActor(input),
      sendOTPSMS: (input) => this.sendOTPSMSActor(input),
      enrollPhone: (input) => this.enrollPhoneActor(input),
      processSMSOtp: (input) => this.processSMSOtpActor(input),
    });
  }

  private spawnActor(
    sessionId: string,
    opts: {
      input?: { sessionId: string; email: string };
      snapshot?: AnyMachineSnapshot;
    },
  ): AuthActor {
    const actor = createActor(this.buildMachine(), opts as never);
    actor.subscribe((snapshot) =>
      this.enqueuePersist(sessionId, snapshot as AnyMachineSnapshot),
    );
    this.sessions.set(sessionId, actor);
    actor.start();
    return actor;
  }

  public async createStateMachine(sessionId: string, email: string) {
    this.failed.delete(sessionId);
    this.spawnActor(sessionId, { input: { sessionId, email } });
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
      const snapshot = record.snapshot as unknown as AnyMachineSnapshot;
      this.lastGood.set(record.sessionId, snapshot);
      this.spawnActor(record.sessionId, { snapshot });
    }

    console.log(`Restored ${records.length} sessions from database`);
  }

  // ---------------------------------------------------------------------------
  // Crons — transactional-outbox senders. These run external Stytch sends and
  // may write the database directly; the "no persistence in actors" rule does
  // not apply to infrastructure workers.
  // ---------------------------------------------------------------------------

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
      results.map((result, i) => {
        const entry = pending[i];
        if (result.status === 'fulfilled') {
          entry.status = OutboxStatus.SENT;
          console.log('sent sms otp!');

          // Feed the Stytch phone_id back into the live actor; the subscribe
          // handler then persists it with the snapshot. No direct DB write.
          const actor = this.sessions.get(entry.sessionId);
          if (actor) {
            actor.send({
              type: 'sms_dispatched',
              phoneId: result.value.phone_id,
            });
          } else {
            console.warn(
              `No in-memory actor for session ${entry.sessionId}; phone_id not delivered.`,
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

  // ---------------------------------------------------------------------------
  // HTTP-facing methods — all non-blocking. They send an event and return; the
  // frontend polls getStatus to learn when to advance.
  // ---------------------------------------------------------------------------

  public sendMagicLink = async (email: string) => {
    const sessionId = crypto.randomUUID();
    await this.createStateMachine(sessionId, email);
    return { sessionId };
  };

  public handleMagicLink({
    sessionId,
    token,
  }: {
    sessionId: string;
    token: string;
  }): void {
    const actor = this.sessions.get(sessionId);
    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }
    this.sendChecked(actor, { type: 'received_magic_link', token });
  }

  public enrollPhone({
    sessionId,
    phoneNumber,
  }: {
    sessionId: string;
    phoneNumber: string;
  }): void {
    const actor = this.sessions.get(sessionId);
    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }
    this.sendChecked(actor, { type: 'received_phone_number', phoneNumber });
  }

  public submitOtp({
    sessionId,
    code,
  }: {
    sessionId: string;
    code: string;
  }): void {
    const actor = this.sessions.get(sessionId);
    if (!actor) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }
    this.sendChecked(actor, { type: 'received_otp', code });
  }

  // ---------------------------------------------------------------------------
  // Status — what page should the frontend show? Reads the live actor when
  // present (freshest), falling back to the persisted row.
  // ---------------------------------------------------------------------------

  public async getStatus(
    sessionId: string,
  ): Promise<{ state: string; sessionToken: string | null } | null> {
    if (this.failed.has(sessionId)) {
      return { state: 'error', sessionToken: null };
    }

    const actor = this.sessions.get(sessionId);
    if (actor) {
      const snapshot = actor.getSnapshot();
      return {
        state: this.topLevelState(snapshot.value),
        sessionToken: (snapshot.context as AuthMachineContext).sessionToken,
      };
    }

    const record = await this.datasource
      .getRepository(FSM)
      .findOne({ where: { sessionId } });
    if (!record) return null;

    return {
      state: this.topLevelState((record.snapshot as { value: unknown }).value),
      sessionToken: record.sessionToken,
    };
  }

  private topLevelState(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return Object.keys(value)[0];
    return 'error';
  }

  private sendChecked(actor: AuthActor, event: any): void {
    const snapshot = actor.getSnapshot();

    if (!snapshot.can(event)) {
      throw new ConflictException(
        `Cannot process '${event.type}' from state ${JSON.stringify(snapshot.value)}`,
      );
    }

    actor.send(event);
  }
}
