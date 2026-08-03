import { createHash, randomUUID } from 'node:crypto';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';

export type AttachmentRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
};

type CloudAsset = {
  publicId: string;
  context: Record<string, string>;
};

export type CloudinaryGateway = {
  upload(input: {
    publicId: string;
    name: string;
    data: Buffer;
    context: Record<string, string>;
  }): Promise<CloudAsset>;
  list(prefix: string): Promise<CloudAsset[]>;
  download(publicId: string): Promise<Buffer>;
  remove(publicId: string): Promise<boolean>;
};

export class AttachmentStorage {
  private readonly folder: string;
  private readonly gateway: CloudinaryGateway;
  private readonly cache = new Map<string, { record: AttachmentRecord; publicId: string }>();

  constructor(options: {
    cloudinaryUrl?: string;
    folder?: string;
    gateway?: CloudinaryGateway;
  }) {
    this.folder = cleanFolder(options.folder ?? 'one-ai-hub/chat-attachments');
    this.gateway = options.gateway ?? createCloudinaryGateway(options.cloudinaryUrl ?? '');
  }

  async save(userId: string, conversationId: string, file: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): Promise<AttachmentRecord> {
    const record: AttachmentRecord = {
      id: randomUUID(),
      name: cleanFileName(file.name),
      mimeType: file.mimeType || 'application/octet-stream',
      size: file.data.byteLength,
      createdAt: new Date(),
    };
    const publicId = this.publicId(userId, conversationId, record.id);
    const asset = await this.gateway.upload({
      publicId,
      name: record.name,
      data: file.data,
      context: encodeRecord(record),
    });
    this.cache.set(publicId, { record, publicId: asset.publicId });
    return record;
  }

  async list(userId: string, conversationId: string): Promise<AttachmentRecord[]> {
    const prefix = this.prefix(userId, conversationId);
    const records = (await this.gateway.list(prefix))
      .map((asset) => {
        const record = decodeRecord(asset.context);
        if (record) this.cache.set(`${prefix}${record.id}`, { record, publicId: asset.publicId });
        return record;
      })
      .filter((record): record is AttachmentRecord => Boolean(record))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return records;
  }

  async read(userId: string, conversationId: string, attachmentId: string): Promise<{
    record: AttachmentRecord;
    data: Buffer;
  } | null> {
    assertId(attachmentId);
    const publicId = this.publicId(userId, conversationId, attachmentId);
    let cached = this.cache.get(publicId);
    if (!cached) {
      await this.list(userId, conversationId);
      cached = this.cache.get(publicId);
    }
    if (!cached) return null;
    return { record: cached.record, data: await this.gateway.download(cached.publicId) };
  }

  async remove(userId: string, conversationId: string, attachmentId: string): Promise<boolean> {
    assertId(attachmentId);
    const publicId = this.publicId(userId, conversationId, attachmentId);
    let cached = this.cache.get(publicId);
    if (!cached) {
      await this.list(userId, conversationId);
      cached = this.cache.get(publicId);
    }
    if (!cached) return false;
    const removed = await this.gateway.remove(cached.publicId);
    if (removed) this.cache.delete(publicId);
    return removed;
  }

  async removeConversation(userId: string, conversationId: string): Promise<void> {
    const assets = await this.gateway.list(this.prefix(userId, conversationId));
    await Promise.all(assets.map(async (asset) => {
      await this.gateway.remove(asset.publicId);
    }));
    for (const key of this.cache.keys()) {
      if (key.startsWith(this.prefix(userId, conversationId))) this.cache.delete(key);
    }
  }

  private prefix(userId: string, conversationId: string): string {
    return `${this.folder}/${safeKey(userId)}/${safeKey(conversationId)}/`;
  }

  private publicId(userId: string, conversationId: string, attachmentId: string): string {
    return `${this.prefix(userId, conversationId)}${attachmentId}`;
  }
}

export function createCloudinaryGateway(cloudinaryUrl: string): CloudinaryGateway {
  cloudinary.config({ ...parseCloudinaryUrl(cloudinaryUrl), secure: true });

  return {
    async upload(input) {
      const result = await uploadRawAsset(input);
      return { publicId: result.public_id, context: normalizeContext(result.context) };
    },

    async list(prefix) {
      const assets: CloudAsset[] = [];
      let nextCursor: string | undefined;
      do {
        const response = await cloudinary.api.resources({
          resource_type: 'raw',
          type: 'authenticated',
          prefix,
          context: true,
          max_results: 500,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        }) as {
          resources?: Array<{ public_id: string; context?: unknown }>;
          next_cursor?: string;
        };
        for (const resource of response.resources ?? []) {
          assets.push({
            publicId: resource.public_id,
            context: normalizeContext(resource.context),
          });
        }
        nextCursor = response.next_cursor;
      } while (nextCursor);
      return assets;
    },

    async download(publicId) {
      const url = cloudinary.utils.private_download_url(publicId, '', {
        resource_type: 'raw',
        type: 'authenticated',
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Cloudinary download failed with status ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    },

    async remove(publicId) {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: 'raw',
        type: 'authenticated',
        invalidate: true,
      });
      if (result.result === 'ok') return true;
      if (result.result === 'not found') return false;
      throw new Error(`Cloudinary deletion failed: ${result.result}.`);
    },
  };
}

function uploadRawAsset(input: {
  publicId: string;
  name: string;
  data: Buffer;
  context: Record<string, string>;
}): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: input.publicId,
        filename_override: input.name,
        resource_type: 'raw',
        type: 'authenticated',
        overwrite: false,
        context: input.context,
      },
      (error, result) => {
        if (error) reject(error);
        else if (!result) reject(new Error('Cloudinary returned no upload result.'));
        else resolve(result);
      },
    );
    stream.end(input.data);
  });
}

function encodeRecord(record: AttachmentRecord): Record<string, string> {
  return {
    attachment_id: record.id,
    original_name: Buffer.from(record.name).toString('base64url'),
    mime_type: Buffer.from(record.mimeType).toString('base64url'),
    byte_size: String(record.size),
    created_at: record.createdAt.toISOString(),
  };
}

function decodeRecord(context: Record<string, string>): AttachmentRecord | null {
  const id = context.attachment_id;
  const originalName = context.original_name;
  const mimeType = context.mime_type;
  const size = Number(context.byte_size);
  const createdAt = new Date(context.created_at ?? '');
  if (!id || !originalName || !mimeType || !Number.isFinite(size) || Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return {
    id,
    name: Buffer.from(originalName, 'base64url').toString(),
    mimeType: Buffer.from(mimeType, 'base64url').toString(),
    size,
    createdAt,
  };
}

function normalizeContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const outer = value as Record<string, unknown>;
  const source = outer.custom && typeof outer.custom === 'object'
    ? outer.custom as Record<string, unknown>
    : outer;
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function parseCloudinaryUrl(value: string): {
  cloud_name: string;
  api_key: string;
  api_secret: string;
} {
  if (!value) throw new Error('CLOUDINARY_URL is required for attachment storage.');
  const url = new URL(value);
  if (url.protocol !== 'cloudinary:' || !url.username || !url.password || !url.hostname) {
    throw new Error('CLOUDINARY_URL must use cloudinary://api_key:api_secret@cloud_name.');
  }
  return {
    cloud_name: url.hostname,
    api_key: decodeURIComponent(url.username),
    api_secret: decodeURIComponent(url.password),
  };
}

function cleanFolder(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').trim() || 'one-ai-hub/chat-attachments';
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error('Invalid attachment identifier.');
}

function cleanFileName(value: string): string {
  const name = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '').trim() || 'attachment';
  return name.slice(0, 180);
}
