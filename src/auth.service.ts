import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Actor, createActor, createMachine } from 'xstate';
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

type AuthActor = ReturnType<typeof createAuthMachine>;

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  private readonly sessions = new Map<string, Actor<AuthActor>>();

  public sendMagicLink = async (email: string) => {
    const sessionId = crypto.randomUUID();
    const actor = this.createStateMachine(email);

    actor.start();
    this.sessions.set(sessionId, actor);
    actor.send({ type: 'received_magic_link_submission', email });

    return { sessionId };
  };

  public sendMagicLinkActor = async ({ email }: SendMagicLinkInput) => {
    await this.stytch.magicLinks.email.loginOrCreate({
      email,
      login_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
      signup_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
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
      sendMagicLink: (input) => this.sendMagicLinkActor(input),
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
