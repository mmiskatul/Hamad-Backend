import { randomUUID } from 'node:crypto';
import type { SupportRepository, SupportTicketRecord } from './supportRepository.js';

export type PublicSupportTicket = {
  id: string;
  subject: string;
  status: SupportTicketRecord['status'];
  createdAt: string;
};

export class SupportService {
  constructor(private readonly repository: SupportRepository) {}

  async submit(input: {
    userId: string;
    email: string;
    name: string;
    subject: string;
    message: string;
  }): Promise<PublicSupportTicket> {
    const createdAt = new Date();
    const ticket = await this.repository.createTicket({
      id: randomUUID(),
      userId: input.userId,
      email: input.email.trim(),
      name: input.name.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
      status: 'open',
      createdAt,
    });
    return publicTicket(ticket);
  }
}

function publicTicket(ticket: SupportTicketRecord): PublicSupportTicket {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt.toISOString(),
  };
}