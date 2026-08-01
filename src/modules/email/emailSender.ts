export type RegistrationCodeEmail = {
  to: string;
  code: string;
  expiresInMinutes: number;
};

export type PasswordResetCodeEmail = RegistrationCodeEmail;

export interface EmailSender {
  sendRegistrationCode(message: RegistrationCodeEmail): Promise<void>;
  sendPasswordResetCode(message: PasswordResetCodeEmail): Promise<void>;
}
