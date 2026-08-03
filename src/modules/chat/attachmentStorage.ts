import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AttachmentRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
};

type StoredMetadata = Omit<AttachmentRecord, 'createdAt'> & { createdAt: string };

export class AttachmentStorage {
  constructor(private readonly root: string) {}

  async save(userId: string, conversationId: string, file: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): Promise<AttachmentRecord> {
    const id = randomUUID();
    const createdAt = new Date();
    const record: AttachmentRecord = {
      id,
      name: cleanFileName(file.name),
      mimeType: file.mimeType || 'application/octet-stream',
      size: file.data.byteLength,
      createdAt,
    };
    const directory = this.directory(userId, conversationId);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, `${id}.bin`), file.data, { flag: 'wx' }),
      writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({ ...record, createdAt: createdAt.toISOString() } satisfies StoredMetadata),
        { flag: 'wx' },
      ),
    ]);
    return record;
  }

  async list(userId: string, conversationId: string): Promise<AttachmentRecord[]> {
    const directory = this.directory(userId, conversationId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names.filter((name) => name.endsWith('.json')).map(async (name) => {
        const raw = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as StoredMetadata;
        return { ...raw, createdAt: new Date(raw.createdAt) };
      }),
    );
    return records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async read(userId: string, conversationId: string, attachmentId: string): Promise<{
    record: AttachmentRecord;
    data: Buffer;
  } | null> {
    assertId(attachmentId);
    const directory = this.directory(userId, conversationId);
    try {
      const [metadata, data] = await Promise.all([
        readFile(path.join(directory, `${attachmentId}.json`), 'utf8'),
        readFile(path.join(directory, `${attachmentId}.bin`)),
      ]);
      const raw = JSON.parse(metadata) as StoredMetadata;
      return { record: { ...raw, createdAt: new Date(raw.createdAt) }, data };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(userId: string, conversationId: string, attachmentId: string): Promise<boolean> {
    assertId(attachmentId);
    const directory = this.directory(userId, conversationId);
    const existing = await this.read(userId, conversationId, attachmentId);
    if (!existing) return false;
    await Promise.all([
      rm(path.join(directory, `${attachmentId}.json`), { force: true }),
      rm(path.join(directory, `${attachmentId}.bin`), { force: true }),
    ]);
    return true;
  }

  async removeConversation(userId: string, conversationId: string): Promise<void> {
    await rm(this.directory(userId, conversationId), { recursive: true, force: true });
  }

  private directory(userId: string, conversationId: string): string {
    return path.resolve(this.root, safePathKey(userId), safePathKey(conversationId));
  }
}

function safePathKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error('Invalid attachment path identifier.');
}

function cleanFileName(value: string): string {
  const name = path.basename(value).replace(/[\u0000-\u001f]/g, '').trim() || 'attachment';
  return name.slice(0, 180);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
