import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createMachine } from 'xstate';
import { authMachineDefinition } from './auth.machine';
import * as stytch from 'stytch';
import { STYTCH_CLIENT } from './stytch/types/constants';

@Injectable()
export class AuthService {
  constructor(
    private readonly datasource: DataSource,
    @Inject(STYTCH_CLIENT) private readonly stytch: stytch.Client,
  ) {}

  public sendMagicLinkActor = async (email: string) => {
    await this.stytch.magicLinks.email.loginOrCreate({
      email,
      login_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
      signup_magic_link_url: process.env.STYTCH_MAGIC_LINK_URL!,
    });
  };

  public validateMagicLinkActor = async () => {};

  public sendOTPSMSActor = async () => {};

  public validateOTPSMSActor = async () => {};

  public mintSessionActor = async () => {};

  public createStateMachine() {
    const definition = authMachineDefinition;
    definition.actors.sendMagicLink = this.sendMagicLinkActor;
    definition.actors.validateMagicLink = this.validateMagicLinkActor;
    definition.actors.sendOTPSMS = this.sendOTPSMSActor;
    definition.actors.validateOTPSMS = this.validateOTPSMSActor;
    definition.actors.mintSession = this.mintSessionActor;

    const actor = createMachine(authMachineDefinition);
  }
}
