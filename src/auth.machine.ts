import { fromPromise, setup } from 'xstate';

export type AuthMachineContext = {
  email: string;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link_submission'; email: string }
  | { type: 'magic_link_validated'; token: string }
  | { type: 'magic_link_validation_error' }
  | { type: 'received_otp_sms_submission'; code: string }
  | { type: 'otp_sms_validated' }
  | { type: 'otp_sms_validation_error' };

export type SendMagicLinkInput = { email: string };
export type ValidateMagicLinkInput = { token: string };
export type SendOTPSMSInput = { phoneNumber: string };
export type ValidateOTPSMSInput = { code: string; phoneNumber: string };
export type MintSessionInput = { magicLinkToken: string };

export const createAuthMachine = (actors: {
  sendMagicLink: (input: SendMagicLinkInput) => Promise<void>;
  validateMagicLink: (
    input: ValidateMagicLinkInput,
  ) => Promise<{ phoneNumber: string }>;
  sendOTPSMS: (input: SendOTPSMSInput) => Promise<void>;
  validateOTPSMS: (input: ValidateOTPSMSInput) => Promise<void>;
  mintSession: (input: MintSessionInput) => Promise<{ sessionToken: string }>;
}) =>
  setup({
    types: {
      context: {} as AuthMachineContext,
      events: {} as AuthMachineEvents,
      input: {} as { email: string },
    },
    actors: {
      sendMagicLink: fromPromise<void, SendMagicLinkInput>(({ input }) =>
        actors.sendMagicLink(input),
      ),
      validateMagicLink: fromPromise<
        { phoneNumber: string },
        ValidateMagicLinkInput
      >(({ input }) => actors.validateMagicLink(input)),
      sendOTPSMS: fromPromise<void, SendOTPSMSInput>(({ input }) =>
        actors.sendOTPSMS(input),
      ),
      validateOTPSMS: fromPromise<void, ValidateOTPSMSInput>(({ input }) =>
        actors.validateOTPSMS(input),
      ),
      mintSession: fromPromise<{ sessionToken: string }, MintSessionInput>(
        ({ input }) => actors.mintSession(input),
      ),
    },
  }).createMachine({
    id: 'auth',
    initial: 'sending_magic_link',
    context: ({ input }: { input: { email: string } }) => ({
      email: input.email,
      magicLinkToken: null,
      phoneNumber: null,
    }),
    states: {
      sending_magic_link: {
        invoke: {
          src: 'sendMagicLink',
          input: ({ context }) => ({ email: context.email }),
          onDone: 'awaiting_magic_link',
          onError: 'idle',
        },
      },
      awaiting_magic_link: {},
      idle: {},
    },
  });
