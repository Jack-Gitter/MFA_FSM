import { AnyActorRef, fromPromise, setup } from 'xstate';

export type AuthMachineContext = {
  email: string;
  sessionId: string;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link'; token: string }
  | { type: 'received_otp'; code: string };

export type SendMagicLinkInput = { sessionId: string; email: string };
export type ProcessMagicLinkInput = { sessionId: string; token: string };
export type SendOTPSMSInput = { sessionId: string };
export type ProcessSMSOtpInput = { sessionId: string; code: string };
export type MintSessionInput = { sessionId: string };

export const createAuthMachine = (actors: {
  sendMagicLink: (
    input: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  processMagicLink: (
    input: ProcessMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  sendOTPSMS: (input: SendOTPSMSInput, parent?: AnyActorRef) => Promise<void>;
  processSMSOtp: (
    input: ProcessSMSOtpInput,
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
      processMagicLink: fromPromise<void, ProcessMagicLinkInput>(
        ({ input, self }) =>
          actors.processMagicLink(input, self._parent ?? undefined),
      ),
      sendOTPSMS: fromPromise<void, SendOTPSMSInput>(({ input, self }) =>
        actors.sendOTPSMS(input, self._parent ?? undefined),
      ),
      processSMSOtp: fromPromise<void, ProcessSMSOtpInput>(({ input, self }) =>
        actors.processSMSOtp(input, self._parent ?? undefined),
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
          onDone: 'processing_magic_link',
          onError: 'error',
        },
      },

      processing_magic_link: {
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              received_magic_link: 'processing',
            },
          },
          processing: {
            invoke: {
              src: 'processMagicLink',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                token: (event as { type: 'received_magic_link'; token: string })
                  .token,
              }),
              onDone: '#auth.send_sms_otp',
              onError: '#auth.error',
            },
          },
        },
      },

      send_sms_otp: {
        invoke: {
          src: 'sendOTPSMS',
          input: ({ context }) => ({
            sessionId: context.sessionId,
          }),
          onDone: 'processing_sms_otp',
          onError: 'error',
        },
      },

      processing_sms_otp: {
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              received_otp: 'processing',
            },
          },
          processing: {
            invoke: {
              src: 'processSMSOtp',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                code: (event as { type: 'received_otp'; code: string }).code,
              }),
              onDone: '#auth.mint_session',
              onError: '#auth.error',
            },
          },
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
