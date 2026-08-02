import type { SupportRepository, SupportTicketRecord } from '../../src/modules/support/supportRepository.js';

export class MemorySupportRepository implements SupportRepository {
  readonly tickets: SupportTicketRecord[] = [];

  async ensureIndexes(): Promise<void> {}

  async createTicket(ticket: SupportTicketRecord): Promise<SupportTicketRecord> {
    this.tickets.push(ticket);
    return ticket;
  }
}