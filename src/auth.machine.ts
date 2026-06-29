import { AnyActorRef, fromPromise, setup } from 'xstate';

export type AuthMachineContext = {
  email: string;
  sessionId: string;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link'; token: string }
  | { type: 'received_otp'; code: string }
  | { type: 'received_phone_number'; phoneNumber: string };

export type SendMagicLinkInput = { sessionId: string; email: string };
export type ProcessMagicLinkInput = { sessionId: string; token: string };
export type ProcessMagicLinkOutput = { hasPhone: boolean };
export type SendOTPSMSInput = { sessionId: string; email: string };
export type EnrollPhoneInput = { sessionId: string; phoneNumber: string };
export type ProcessSMSOtpInput = { sessionId: string; code: string };

export const createAuthMachine = (actors: {
  sendMagicLink: (
    input: SendMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
  processMagicLink: (
    input: ProcessMagicLinkInput,
    parent?: AnyActorRef,
  ) => Promise<ProcessMagicLinkOutput>;
  sendOTPSMS: (input: SendOTPSMSInput, parent?: AnyActorRef) => Promise<void>;
  enrollPhone: (input: EnrollPhoneInput, parent?: AnyActorRef) => Promise<void>;
  processSMSOtp: (
    input: ProcessSMSOtpInput,
    parent?: AnyActorRef,
  ) => Promise<void>;
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
      processMagicLink: fromPromise<
        ProcessMagicLinkOutput,
        ProcessMagicLinkInput
      >(({ input, self }) =>
        actors.processMagicLink(input, self._parent ?? undefined),
      ),
      sendOTPSMS: fromPromise<void, SendOTPSMSInput>(({ input, self }) =>
        actors.sendOTPSMS(input, self._parent ?? undefined),
      ),
      enrollPhone: fromPromise<void, EnrollPhoneInput>(({ input, self }) =>
        actors.enrollPhone(input, self._parent ?? undefined),
      ),
      processSMSOtp: fromPromise<void, ProcessSMSOtpInput>(({ input, self }) =>
        actors.processSMSOtp(input, self._parent ?? undefined),
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
              onDone: [
                {
                  guard: ({ event }) => event.output.hasPhone === false,
                  target: '#auth.processing_phone_enrollment',
                },
                {
                  target: '#auth.send_sms_otp',
                },
              ],
              onError: '#auth.error',
            },
          },
        },
      },

      processing_phone_enrollment: {
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              received_phone_number: 'processing',
            },
          },
          processing: {
            invoke: {
              src: 'enrollPhone',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                phoneNumber: (
                  event as {
                    type: 'received_phone_number';
                    phoneNumber: string;
                  }
                ).phoneNumber,
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
            email: context.email,
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
              onDone: '#auth.complete',
              onError: '#auth.error',
            },
          },
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
