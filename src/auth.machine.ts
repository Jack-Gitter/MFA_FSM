export const authMachineDefinition = {
  types: {
    events: {} as
      | { type: 'received_magic_link_submission' }
      | { type: 'magic_link_validated' }
      | { type: 'magic_link_validation_error' }
      | { type: 'received_otp_sms_submission' }
      | { type: 'otp_sms_validated' }
      | { type: 'otp_sms_validation_error' },
  },
  actors: {
    sendMagicLink: (email: string) => {},
    validateMagicLink: () => {},
    sendOTPSMS: () => {},
    validateOTPSMS: () => {},
    mintSession: () => {},
  },
};
