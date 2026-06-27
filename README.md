* SEND_MAGIC_LINK
* WAITING_FOR_MAGIC_LINK_INPUT
* VALIDATE_MAGIC_LINK
* SEND_SMS_OTP
* WAITING_FOR_OTP_INPUT
* VALIDATE_SMS_OTP
* MINT_SESSION

* next up
    * don't go to stytch api in order to fetch the user, just use the session token to see if the user has a phone number or not
    * make sure that each step is idempotent 
    * make sure that if we fail at any point, the state machine can come back up and keep moving along and doesn't get stuck anywhere
    * somehow return stytch session to FE clearner

