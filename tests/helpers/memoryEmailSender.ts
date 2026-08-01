import type {
  EmailSender,
  RegistrationCodeEmail,
} from '../../src/modules/email/emailSender.js';

export class MemoryEmailSender implements EmailSender {
  readonly messages: RegistrationCodeEmail[] = [];

  async sendRegistrationCode(message: RegistrationCodeEmail): Promise<void> {
    this.messages.push(message);
  }
}
