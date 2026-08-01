export type RegistrationCodeEmail = {
  to: string;
  code: string;
  expiresInMinutes: number;
};

export interface EmailSender {
  sendRegistrationCode(message: RegistrationCodeEmail): Promise<void>;
}
