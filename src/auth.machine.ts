import { setup } from 'xstate';

/**
 * A THIN, stateless state machine. It holds no long-lived runtime state and
 * does no work or persistence. It is used purely as a decision oracle:
 *   - machine.resolveState({ value }) rehydrates a snapshot at a stored state
 *   - snapshot.can(event)            checks whether the event is legal there
 *   - getNextSnapshot(machine, ...)  computes the destination state
 *
 * The actual work and the DB persistence live in the HTTP handlers
 * (auth.service.ts), which commit the new state alongside the changed data
 * in a single transaction. The DB row is the single source of truth.
 */

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
