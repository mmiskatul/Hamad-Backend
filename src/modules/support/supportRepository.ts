export type SupportTicketStatus = 'open';

export type SupportTicketRecord = {
  id: string;
  userId: string;
  email: string;
  name: string;
  subject: string;
  message: string;
  status: SupportTicketStatus;
  createdAt: Date;
};

export interface SupportRepository {
  ensureIndexes(): Promise<void>;
  createTicket(ticket: SupportTicketRecord): Promise<SupportTicketRecord>;
}