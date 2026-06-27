import { AnyActorRef, fromPromise, setup } from 'xstate';

export type AuthMachineContext = {
  email: string;
  sessionId: string;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link'; token: string }
  | { type: 'received_otp'; code: string };

export type SendMagicLinkInput = { sessionId: string; email: string };
export type StoreMagicLinkTokenInput = { sessionId: string; token: string };
export type ValidateMagicLinkInput = { sessionId: string };
export type SendOTPSMSInput = { sessionId: string };
export type StoreOTPCodeInput = { sessionId: string; code: string };
export type ValidateOTPSMSInput = { sessionId: string };
export type MintSessionInput = { sessionId: string };

export const createAuthMachine = (actors: {
  sendMagicLink: (
    input: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  storeMagicLinkToken: (
    input: StoreMagicLinkTokenInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  validateMagicLink: (
    input: ValidateMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  sendOTPSMS: (input: SendOTPSMSInput, parent?: AnyActorRef) => Promise<void>;
  storeOTPCode: (
    input: StoreOTPCodeInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  validateOTPSMS: (
    input: ValidateOTPSMSInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  mintSession: (input: MintSessionInput, parent?: AnyActorRef) => Promise<void>;
}) =>
  setup({
    types: {
      context: {} as AuthMachineContext,
      events: {} as AuthMachineEvents,
      input: {} as { sessionId: string; email: string },
    },
    actors: {
      sendMagicLink: fromPromise<void, SendMagicLinkInput>(({ input, self }) =>
        actors.sendMagicLink(input, self._parent ?? undefined),
      ),
      storeMagicLinkToken: fromPromise<void, StoreMagicLinkTokenInput>(
        ({ input, self }) =>
          actors.storeMagicLinkToken(input, self._parent ?? undefined),
      ),
      validateMagicLink: fromPromise<void, ValidateMagicLinkInput>(
        ({ input, self }) =>
          actors.validateMagicLink(input, self._parent ?? undefined),
      ),
      sendOTPSMS: fromPromise<void, SendOTPSMSInput>(({ input, self }) =>
        actors.sendOTPSMS(input, self._parent ?? undefined),
      ),
      storeOTPCode: fromPromise<void, StoreOTPCodeInput>(({ input, self }) =>
        actors.storeOTPCode(input, self._parent ?? undefined),
      ),
      validateOTPSMS: fromPromise<void, ValidateOTPSMSInput>(
        ({ input, self }) =>
          actors.validateOTPSMS(input, self._parent ?? undefined),
      ),
      mintSession: fromPromise<void, MintSessionInput>(({ input, self }) =>
        actors.mintSession(input, self._parent ?? undefined),
      ),
    },
  }).createMachine({
    id: 'auth',
    initial: 'send_magic_link',
    context: ({ input }) => ({
      sessionId: input.sessionId,
      email: input.email,
    }),
    states: {
      send_magic_link: {
        invoke: {
          src: 'sendMagicLink',
          input: ({ context }) => ({
            sessionId: context.sessionId,
            email: context.email,
          }),
          onDone: 'waiting_for_magic_link_input',
          onError: 'error',
        },
      },

      waiting_for_magic_link_input: {
        initial: 'idle',
        states: {
          idle: {
            on: {
              received_magic_link: 'storing',
            },
          },
          storing: {
            invoke: {
              src: 'storeMagicLinkToken',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                token: (event as { type: 'received_magic_link'; token: string })
                  .token,
              }),
              onDone: '#auth.validate_magic_link',
              onError: '#auth.error',
            },
          },
        },
      },

      validate_magic_link: {
        invoke: {
          src: 'validateMagicLink',
          input: ({ context }) => ({
            sessionId: context.sessionId,
          }),
          onDone: 'send_sms_otp',
          onError: 'error',
        },
      },

      send_sms_otp: {
        invoke: {
          src: 'sendOTPSMS',
          input: ({ context }) => ({
            sessionId: context.sessionId,
          }),
          onDone: 'waiting_for_otp_input',
          onError: 'error',
        },
      },

      waiting_for_otp_input: {
        initial: 'idle',
        states: {
          idle: {
            on: {
              received_otp: 'storing',
            },
          },
          storing: {
            invoke: {
              src: 'storeOTPCode',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                code: (event as { type: 'received_otp'; code: string }).code,
              }),
              onDone: '#auth.validate_sms_otp',
              onError: '#auth.error',
            },
          },
        },
      },

      validate_sms_otp: {
        invoke: {
          src: 'validateOTPSMS',
          input: ({ context }) => ({
            sessionId: context.sessionId,
          }),
          onDone: 'mint_session',
          onError: 'error',
        },
      },

      mint_session: {
        invoke: {
          src: 'mintSession',
          input: ({ context }) => ({
            sessionId: context.sessionId,
          }),
          onDone: 'complete',
          onError: 'error',
        },
      },

      complete: {
        type: 'final',
      },

      error: {
        type: 'final',
      },
    },
  });
