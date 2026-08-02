import type { Collection, Db } from 'mongodb';
import type { SupportRepository, SupportTicketRecord } from './supportRepository.js';

export class MongoSupportRepository implements SupportRepository {
  private readonly tickets: Collection<SupportTicketRecord & { _id: string }>;
  private indexesReady: Promise<void> | null = null;

  constructor(db: Db) {
    this.tickets = db.collection('support_tickets');
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= Promise.all([
      this.tickets.createIndex({ userId: 1, createdAt: -1 }),
      this.tickets.createIndex({ status: 1, createdAt: -1 }),
    ]).then(() => undefined);
    return this.indexesReady;
  }

  async createTicket(ticket: SupportTicketRecord): Promise<SupportTicketRecord> {
    await this.ensureIndexes();
    await this.tickets.insertOne({ _id: ticket.id, ...ticket });
    return ticket;
  }
}