import { fromPromise, setup, assign } from 'xstate';
import { FSM } from './db/entities/fsm.entity';
import { MagicLinkOutbox, OutboxStatus } from './db/entities/email-outbox.entity';
import { SMSOTPOutbox } from './db/entities/sms-outbox.entity';

export type PendingWrites = {
  fsm?: Partial<FSM>;
  magicLinkOutbox?: Partial<MagicLinkOutbox>;
  smsOutbox?: Partial<SMSOTPOutbox>;
};

export type AuthMachineContext = {
  email: string;
  sessionId: string;
  pendingWrites: PendingWrites;
};

export type AuthMachineEvents =
  | { type: 'received_magic_link'; token: string }
  | { type: 'received_otp'; code: string }
  | { type: 'received_phone_number'; phoneNumber: string };

export type SendMagicLinkInput = { sessionId: string; email: string };
export type SendMagicLinkOutput = { magicLinkOutbox: Partial<MagicLinkOutbox> };

export type ProcessMagicLinkInput = { sessionId: string; token: string };
export type ProcessMagicLinkOutput = {
  hasPhone: boolean;
  fsm: Partial<FSM>;
};

export type SendOTPSMSInput = { sessionId: string };
export type SendOTPSMSOutput = { smsOutbox: Partial<SMSOTPOutbox> };

export type EnrollPhoneInput = { sessionId: string; phoneNumber: string };
export type EnrollPhoneOutput = { fsm: Partial<FSM> };

export type ProcessSMSOtpInput = { sessionId: string; code: string };
export type ProcessSMSOtpOutput = { fsm: Partial<FSM> };

export const createAuthMachine = (actors: {
  sendMagicLink: (input: SendMagicLinkInput) => Promise<SendMagicLinkOutput>;
  processMagicLink: (input: ProcessMagicLinkInput) => Promise<ProcessMagicLinkOutput>;
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
      processMagicLink: fromPromise<ProcessMagicLinkOutput, ProcessMagicLinkInput>(
        ({ input }) => actors.processMagicLink(input),
      ),
      sendOTPSMS: fromPromise<SendOTPSMSOutput, SendOTPSMSInput>(
        ({ input }) => actors.sendOTPSMS(input),
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
      pendingWrites: {},
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
              pendingWrites: ({ event }) => ({
                magicLinkOutbox: event.output.magicLinkOutbox,
              }),
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
                token: (event as { type: 'received_magic_link'; token: string }).token,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.hasPhone === false,
                  target: '#auth.processing_phone_enrollment',
                  actions: assign({
                    pendingWrites: ({ event }) => ({
                      fsm: event.output.fsm,
                    }),
                  }),
                },
                {
                  target: '#auth.send_sms_otp',
                  actions: assign({
                    pendingWrites: ({ event }) => ({
                      fsm: event.output.fsm,
                    }),
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
                phoneNumber: (event as { type: 'received_phone_number'; phoneNumber: string }).phoneNumber,
              }),
              onDone: {
                target: '#auth.send_sms_otp',
                actions: assign({
                  pendingWrites: ({ event }) => ({
                    fsm: event.output.fsm,
                  }),
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
          }),
          onDone: {
            target: 'processing_sms_otp',
            actions: assign({
              pendingWrites: ({ event }) => ({
                smsOutbox: event.output.smsOutbox,
              }),
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
              onDone: {
                target: '#auth.complete',
                actions: assign({
                  pendingWrites: ({ event }) => ({
                    fsm: event.output.fsm,
                  }),
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
