import { assign, fromPromise, setup } from 'xstate';
import * as stytch from 'stytch';

export type MagicLinkOutboxData = { sessionId: string; email: string };
export type SMSOTPOutboxData = {
  sessionId: string;
  phoneNumber: string;
  sessionToken: string;
};

export type AuthMachineContext = {
  sessionId: string;
  email: string;
  processedMagicLink: boolean;
  enrollPhoneNumber: string | null;
  intermediarySessionToken: string | null;
  stytchUser: stytch.User | null;
  sessionToken: string | null;
  phoneId: string | null;
  // Pending outbox rows produced in-memory by actors; persisted (insert-or-ignore)
  // by the subscribe handler alongside the snapshot, then sent by the crons.
  magicLinkOutbox: MagicLinkOutboxData | null;
  smsOtpOutbox: SMSOTPOutboxData | null;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link'; token: string }
  | { type: 'received_otp'; code: string }
  | { type: 'received_phone_number'; phoneNumber: string }
  | { type: 'sms_dispatched'; phoneId: string };

export type SendMagicLinkInput = { sessionId: string; email: string };
export type SendMagicLinkOutput = { magicLinkOutbox: MagicLinkOutboxData };

export type ProcessMagicLinkInput = {
  sessionId: string;
  token: string;
  processedMagicLink: boolean;
  stytchUser: stytch.User | null;
  intermediarySessionToken: string | null;
};
export type ProcessMagicLinkOutput = {
  stytchUser: stytch.User;
  intermediarySessionToken: string;
};

export type EnrollPhoneInput = { sessionId: string; phoneNumber: string };
export type EnrollPhoneOutput = { enrollPhoneNumber: string };

export type SendOTPSMSInput = {
  sessionId: string;
  enrollPhoneNumber: string | null;
  stytchUser: stytch.User | null;
  intermediarySessionToken: string | null;
};
export type SendOTPSMSOutput = { smsOtpOutbox: SMSOTPOutboxData };

export type ProcessSMSOtpInput = {
  sessionId: string;
  code: string;
  phoneId: string | null;
  intermediarySessionToken: string | null;
  sessionToken: string | null;
};
export type ProcessSMSOtpOutput = { sessionToken: string };

const hasPhone = (user: stytch.User | null): boolean =>
  (user?.phone_numbers?.length ?? 0) > 0;

export const createAuthMachine = (actors: {
  sendMagicLink: (input: SendMagicLinkInput) => Promise<SendMagicLinkOutput>;
  processMagicLink: (
    input: ProcessMagicLinkInput,
  ) => Promise<ProcessMagicLinkOutput>;
  sendOTPSMS: (input: SendOTPSMSInput) => Promise<SendOTPSMSOutput>;
  enrollPhone: (input: EnrollPhoneInput) => Promise<EnrollPhoneOutput>;
  processSMSOtp: (input: ProcessSMSOtpInput) => Promise<ProcessSMSOtpOutput>;
}) =>
  setup({
    types: {
      context: {} as AuthMachineContext,
      events: {} as AuthMachineEvents,
      input: {} as { sessionId: string; email: string },
    },
    actors: {
      sendMagicLink: fromPromise<SendMagicLinkOutput, SendMagicLinkInput>(
        ({ input }) => actors.sendMagicLink(input),
      ),
      processMagicLink: fromPromise<
        ProcessMagicLinkOutput,
        ProcessMagicLinkInput
      >(({ input }) => actors.processMagicLink(input)),
      sendOTPSMS: fromPromise<SendOTPSMSOutput, SendOTPSMSInput>(({ input }) =>
        actors.sendOTPSMS(input),
      ),
      enrollPhone: fromPromise<EnrollPhoneOutput, EnrollPhoneInput>(
        ({ input }) => actors.enrollPhone(input),
      ),
      processSMSOtp: fromPromise<ProcessSMSOtpOutput, ProcessSMSOtpInput>(
        ({ input }) => actors.processSMSOtp(input),
      ),
    },
  }).createMachine({
    id: 'auth',
    initial: 'send_magic_link',
    context: ({ input }) => ({
      sessionId: input.sessionId,
      email: input.email,
      processedMagicLink: false,
      enrollPhoneNumber: null,
      intermediarySessionToken: null,
      stytchUser: null,
      sessionToken: null,
      phoneId: null,
      magicLinkOutbox: null,
      smsOtpOutbox: null,
    }),
    states: {
      send_magic_link: {
        invoke: {
          src: 'sendMagicLink',
          input: ({ context }) => ({
            sessionId: context.sessionId,
            email: context.email,
          }),
          onDone: {
            target: 'processing_magic_link',
            actions: assign({
              magicLinkOutbox: ({ event }) => event.output.magicLinkOutbox,
            }),
          },
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
                processedMagicLink: context.processedMagicLink,
                stytchUser: context.stytchUser,
                intermediarySessionToken: context.intermediarySessionToken,
              }),
              onDone: [
                {
                  guard: ({ event }) =>
                    hasPhone(event.output.stytchUser) === false,
                  target: '#auth.processing_phone_enrollment',
                  actions: assign({
                    stytchUser: ({ event }) => event.output.stytchUser,
                    intermediarySessionToken: ({ event }) =>
                      event.output.intermediarySessionToken,
                    processedMagicLink: true,
                  }),
                },
                {
                  target: '#auth.send_sms_otp',
                  actions: assign({
                    stytchUser: ({ event }) => event.output.stytchUser,
                    intermediarySessionToken: ({ event }) =>
                      event.output.intermediarySessionToken,
                    processedMagicLink: true,
                  }),
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
              onDone: {
                target: '#auth.send_sms_otp',
                actions: assign({
                  enrollPhoneNumber: ({ event }) =>
                    event.output.enrollPhoneNumber,
                }),
              },
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
            enrollPhoneNumber: context.enrollPhoneNumber,
            stytchUser: context.stytchUser,
            intermediarySessionToken: context.intermediarySessionToken,
          }),
          onDone: {
            target: 'processing_sms_otp',
            actions: assign({
              smsOtpOutbox: ({ event }) => event.output.smsOtpOutbox,
            }),
          },
          onError: 'error',
        },
      },

      processing_sms_otp: {
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              // The SMS cron feeds the Stytch phone_id back into the live actor
              // once the OTP SMS has actually been dispatched.
              sms_dispatched: {
                actions: assign({
                  phoneId: ({ event }) => event.phoneId,
                }),
              },
              received_otp: 'processing',
            },
          },
          processing: {
            invoke: {
              src: 'processSMSOtp',
              input: ({ context, event }) => ({
                sessionId: context.sessionId,
                code: (event as { type: 'received_otp'; code: string }).code,
                phoneId: context.phoneId,
                intermediarySessionToken: context.intermediarySessionToken,
                sessionToken: context.sessionToken,
              }),
              onDone: {
                target: '#auth.complete',
                actions: assign({
                  sessionToken: ({ event }) => event.output.sessionToken,
                }),
              },
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
