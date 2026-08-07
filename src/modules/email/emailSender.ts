export type RegistrationCodeEmail = {
  to: string;
  code: string;
  expiresInMinutes: number;
};

export type PasswordResetCodeEmail = RegistrationCodeEmail;

export type SupportReplyEmail = {
  to: string;
  subject: string;
  message: string;
};

export interface EmailSender {
  sendRegistrationCode(message: RegistrationCodeEmail): Promise<void>;
  sendPasswordResetCode(message: PasswordResetCodeEmail): Promise<void>;
  sendSupportReply?(message: SupportReplyEmail): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async sendRegistrationCode(message: RegistrationCodeEmail): Promise<void> {
    console.info('[email:console] registration code', { to: message.to });
  }
  async sendPasswordResetCode(message: PasswordResetCodeEmail): Promise<void> {
    console.info('[email:console] password reset code', { to: message.to });
  }
  async sendSupportReply(message: SupportReplyEmail): Promise<void> {
    console.info('[email:console] support reply', { to: message.to, subject: message.subject });
  }
}
