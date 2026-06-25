import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createMachine } from 'xstate';
import { authMachineDefinition } from './auth.machine';

@Injectable()
export class AuthService {
  constructor(datasource: DataSource) {}

  public sendMagicLinkActor = async () => {};

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
