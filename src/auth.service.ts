import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { transition } from 'xstate';
import { authMachine, AuthEvent, AuthState } from './auth.machine';
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

  // ---------------------------------------------------------------------------
  // The core transition primitive — the stateless equivalent of sm.Run wrapped
  // in load → run → save → commit. No long-lived machine: we rehydrate the
  // machine from the row's state, gate with can(), compute the destination with
  // transition(), run the handler's work, and persist the new state + the
  // changed data in ONE transaction. Nothing survives the request, so the
  // in-memory state can never diverge from the database.
  // ---------------------------------------------------------------------------
  private async applyTransition(
    sessionId: string,
    event: AuthEvent,
    work?: (
      manager: EntityManager,
      row: FSM,
      nextState: AuthState,
    ) => Promise<void> | void,
  ): Promise<FSM> {
    return this.datasource.transaction(async (manager) => {
      const repo = manager.getRepository(FSM);

      // load (with row lock so concurrent operations serialize)
      const row = await repo.findOne({
        where: { sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException(`No session found: ${sessionId}`);

      // rehydrate the machine at the persisted state and gate the event
      const snapshot = authMachine.resolveState({
        value: row.state,
        context: {},
      });
      if (!snapshot.can(event)) {
        throw new ConflictException(
          `Cannot '${event.type}' from state '${row.state}'`,
        );
      }

      // ask the machine for the destination (pure transition, no running actor)
      const [nextSnapshot] = transition(authMachine, snapshot, event);
      const nextState = nextSnapshot.value as AuthState;

      // the handler's work (the "PostTransition") — mutates row / writes
      // related rows through the same transaction
      await work?.(manager, row, nextState);

      // persist the new state alongside the work, atomically
      row.state = nextState;
      await repo.save(row);
      return row;
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP handlers — all the logic lives here.
  // ---------------------------------------------------------------------------

  // Create a session and enqueue the magic-link email (one transaction).
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

      await manager
        .getRepository(MagicLinkOutbox)
        .createQueryBuilder()
        .insert()
        .values({ email, sessionId, status: OutboxStatus.PENDING })
        .orIgnore()
        .execute();
    });

    return { sessionId };
  }

  public async handleMagicLink(
    sessionId: string,
    token: string,
  ): Promise<void> {
    const row = await this.datasource
      .getRepository(FSM)
      .findOne({ where: { sessionId } });
    if (!row) throw new NotFoundException(`No session found: ${sessionId}`);

    // Gate before the external call so we don't authenticate in the wrong
    // state. (The hasPhone value is irrelevant to whether the event is legal.)
    const gate = authMachine.resolveState({ value: row.state, context: {} });
    if (!gate.can({ type: 'magic_link_verified', hasPhone: true })) {
      throw new ConflictException(
        `Cannot verify magic link from state '${row.state}'`,
      );
    }

    // External, non-idempotent call — OUTSIDE the transaction. Guarded so a
    // retry does not re-consume the single-use token.
    let stytchUser = row.stytchUser;
    let intermediarySessionToken = row.intermediarySessionToken;
    if (!row.processedMagicLink) {
      const result = await this.stytch.magicLinks.authenticate({
        token,
        session_duration_minutes: 10,
      });
      stytchUser = result.user;
      intermediarySessionToken = result.session_token;
    }
    const hasPhone = (stytchUser?.phone_numbers?.length ?? 0) > 0;

    await this.applyTransition(
      sessionId,
      { type: 'magic_link_verified', hasPhone },
      async (manager, r, nextState) => {
        r.stytchUser = stytchUser;
        r.intermediarySessionToken = intermediarySessionToken;
        r.processedMagicLink = true;
        // If we're going straight to OTP, enqueue the SMS in the same txn.
        if (nextState === 'awaiting_otp') {
          await this.enqueueSms(manager, r);
        }
      },
    );
  }

  public async enrollPhone(
    sessionId: string,
    phoneNumber: string,
  ): Promise<void> {
    await this.applyTransition(
      sessionId,
      { type: 'phone_enrolled', phoneNumber },
      async (manager, row) => {
        row.enrollPhoneNumber = phoneNumber;
        await this.enqueueSms(manager, row);
      },
    );
  }

  public async submitOtp(sessionId: string, code: string): Promise<void> {
    const row = await this.datasource
      .getRepository(FSM)
      .findOne({ where: { sessionId } });
    if (!row) throw new NotFoundException(`No session found: ${sessionId}`);

    const gate = authMachine.resolveState({ value: row.state, context: {} });
    if (!gate.can({ type: 'otp_verified' })) {
      throw new ConflictException(
        `Cannot verify OTP from state '${row.state}'`,
      );
    }

    // External, non-idempotent call — OUTSIDE the transaction, idempotency-guarded.
    let sessionToken = row.sessionToken;
    if (!sessionToken) {
      if (!row.phoneId)
        throw new BadRequestException('OTP has not been sent yet');
      const result = await this.stytch.otps.authenticate({
        method_id: row.phoneId,
        code,
        session_token: row.intermediarySessionToken ?? undefined,
        session_duration_minutes: 60,
      });
      sessionToken = result.session_token;
    }

    await this.applyTransition(sessionId, { type: 'otp_verified' }, (_m, r) => {
      r.sessionToken = sessionToken;
    });
  }

  // Enqueue the OTP SMS as an outbox row (sent later by the cron). No external
  // call here — it's a pure DB write, committed with the state change.
  private async enqueueSms(manager: EntityManager, row: FSM): Promise<void> {
    const phoneNumber =
      row.enrollPhoneNumber ?? row.stytchUser?.phone_numbers?.[0]?.phone_number;
    if (!phoneNumber)
      throw new BadRequestException(
        `No phone number on file for ${row.sessionId}`,
      );
    if (!row.intermediarySessionToken)
      throw new BadRequestException(
        `Session ${row.sessionId} not authenticated`,
      );

    await manager
      .getRepository(SMSOTPOutbox)
      .createQueryBuilder()
      .insert()
      .values({
        sessionId: row.sessionId,
        phoneNumber,
        sessionToken: row.intermediarySessionToken,
        status: OutboxStatus.PENDING,
      })
      .orIgnore()
      .execute();
  }

  public async getStatus(
    sessionId: string,
  ): Promise<{ state: string; sessionToken: string | null } | null> {
    const row = await this.datasource
      .getRepository(FSM)
      .findOne({ where: { sessionId } });
    if (!row) return null;
    return { state: row.state, sessionToken: row.sessionToken };
  }

  // ---------------------------------------------------------------------------
  // Crons — the transactional-outbox senders. They make the external Stytch
  // calls and may write the DB directly (they are infrastructure, not actors).
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
      results.map(async (result, i) => {
        const entry = pending[i];
        if (result.status === 'fulfilled') {
          entry.status = OutboxStatus.SENT;
          console.log('sent sms otp!');
          // Write the Stytch phone_id straight onto the session row — it's a
          // field the OTP-verify step needs, not a state transition.
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
}
