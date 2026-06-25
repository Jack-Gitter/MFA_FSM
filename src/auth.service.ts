import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createActor, createMachine } from 'xstate';
import {
  authMachineDefinition,
  createAuthMachine,
  MintSessionInput,
  SendMagicLinkInput,
  SendOTPSMSInput,
  ValidateMagicLinkInput,
  ValidateOTPSMSInput,
} from './auth.machine';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './stytch/types/constants';

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

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

  public createStateMachine() {
    const machine = createAuthMachine({
      sendMagicLink: (input) => this.sendMagicLinkActor(input),
      validateMagicLink: (input) => this.validateMagicLinkActor(input),
      sendOTPSMS: (input) => this.sendOTPSMSActor(input),
      validateOTPSMS: (input) => this.validateOTPSMSActor(input),
      mintSession: (input) => this.mintSessionActor(input),
    });

    return createActor(machine);
  }
}
