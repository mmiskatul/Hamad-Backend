import nodemailer, { type Transporter } from 'nodemailer';
import type {
  EmailSender,
  PasswordResetCodeEmail,
  RegistrationCodeEmail,
} from './emailSender.js';

export type SmtpEmailSenderOptions = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
};

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(private readonly options: SmtpEmailSenderOptions) {
    const missing = Object.entries({
      SMTP_HOST: options.host,
      SMTP_USER: options.user,
      SMTP_PASSWORD: options.password,
      SMTP_FROM_EMAIL: options.fromEmail,
    })
      .filter(([, value]) => !value.trim())
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(`Missing SMTP configuration: ${missing.join(', ')}`);
    }

    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: {
        user: options.user,
        pass: options.password,
      },
    });
  }

  async sendRegistrationCode(message: RegistrationCodeEmail): Promise<void> {
    await this.transporter.sendMail({
      from: { name: this.options.fromName, address: this.options.fromEmail },
      to: message.to,
      subject: 'Verify your One AI Hub email',
      text: [
        `Your One AI Hub verification code is ${message.code}.`,
        `It expires in ${message.expiresInMinutes} minutes.`,
        'If you did not request this code, you can ignore this email.',
      ].join('\n\n'),
      html: `
        <p>Your One AI Hub verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 8px;">${message.code}</p>
        <p>It expires in ${message.expiresInMinutes} minutes.</p>
        <p>If you did not request this code, you can ignore this email.</p>
      `,
    });
  }

  async sendPasswordResetCode(message: PasswordResetCodeEmail): Promise<void> {
    await this.transporter.sendMail({
      from: { name: this.options.fromName, address: this.options.fromEmail },
      to: message.to,
      subject: 'Reset your One AI Hub password',
      text: [
        `Your One AI Hub password reset code is ${message.code}.`,
        `It expires in ${message.expiresInMinutes} minutes.`,
        'If you did not request a password reset, you can ignore this email.',
      ].join('\n\n'),
      html: `
        <p>Your One AI Hub password reset code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 8px;">${message.code}</p>
        <p>It expires in ${message.expiresInMinutes} minutes.</p>
        <p>If you did not request a password reset, you can ignore this email.</p>
      `,
    });
  }
}
