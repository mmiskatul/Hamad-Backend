import type {
  EmailSender,
  PasswordResetCodeEmail,
  RegistrationCodeEmail,
} from '../../src/modules/email/emailSender.js';

export class MemoryEmailSender implements EmailSender {
  readonly messages: RegistrationCodeEmail[] = [];
  readonly passwordResetMessages: PasswordResetCodeEmail[] = [];

  async sendRegistrationCode(message: RegistrationCodeEmail): Promise<void> {
    this.messages.push(message);
  }

  async sendPasswordResetCode(message: PasswordResetCodeEmail): Promise<void> {
    this.passwordResetMessages.push(message);
  }
}
