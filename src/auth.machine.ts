import { setup } from 'xstate';

export type AuthState =
  | 'awaiting_magic_link'
  | 'awaiting_phone'
  | 'awaiting_otp'
  | 'complete'
  | 'error';

export type AuthEvent =
  | { type: 'magic_link_verified'; hasPhone: boolean }
  | { type: 'phone_enrolled'; phoneNumber: string }
  | { type: 'otp_verified' };

export const authMachine = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as AuthEvent,
  },
  guards: {
    hasPhone: ({ event }) =>
      event.type === 'magic_link_verified' && event.hasPhone === true,
  },
}).createMachine({
  id: 'auth',
  initial: 'awaiting_magic_link',
  context: {},
  states: {
    awaiting_magic_link: {
      on: {
        magic_link_verified: [
          { guard: 'hasPhone', target: 'awaiting_otp' },
          { target: 'awaiting_phone' },
        ],
      },
    },
    awaiting_phone: {
      on: { phone_enrolled: 'awaiting_otp' },
    },
    awaiting_otp: {
      on: { otp_verified: 'complete' },
    },
    complete: { type: 'final' },
    error: { type: 'final' },
  },
});
