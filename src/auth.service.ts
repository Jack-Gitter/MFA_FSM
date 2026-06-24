import { Injectable } from '@nestjs/common';
import { fromPromise } from 'xstate';

@Injectable()
export class AuthService {
  public sendMagicLinkActor = fromPromise(
    async ({ input }: { input: { data: any } }) => {},
  );

  public validateMagicLinkActor = fromPromise(
    async ({ input }: { input: { data: any } }) => {},
  );

  public sendOTPSMSActor = fromPromise(
    async ({ input }: { input: { data: any } }) => {},
  );

  public validateOTPSMSActor = fromPromise(
    async ({ input }: { input: { data: any } }) => {},
  );

  public mintSessionActor = fromPromise(
    async ({ input }: { input: { data: any } }) => {},
  );
}
