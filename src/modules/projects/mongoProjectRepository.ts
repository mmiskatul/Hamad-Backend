import type { Collection, Db } from 'mongodb';
import type { CreateProjectInput, ProjectRecord, ProjectRepository, ProjectSource } from './projectRepository.js';

export class MongoProjectRepository implements ProjectRepository {
  private readonly projects: Collection<ProjectRecord & { _id: string }>;
  private indexesReady: Promise<void> | null = null;

  constructor(db: Db) {
    this.projects = db.collection('projects');
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= Promise.all([
      this.projects.createIndex({ userId: 1, updatedAt: -1 }),
      this.projects.createIndex({ userId: 1, name: 1 }),
    ]).then(() => undefined);
    return this.indexesReady;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    await this.ensureIndexes();
    await this.projects.insertOne({ _id: input.id, ...input });
    return input;
  }

  async findProject(userId: string, projectId: string): Promise<ProjectRecord | null> {
    const record = await this.projects.findOne({ _id: projectId, userId });
    return record ? withoutMongoId(record) : null;
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const records = await this.projects.find({ userId }).sort({ pinned: -1, updatedAt: -1 }).toArray();
    return records.map(withoutMongoId);
  }

  async updateProject(
    userId: string,
    projectId: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'description' | 'instructions' | 'scope' | 'pinned' | 'updatedAt'>>,
  ): Promise<ProjectRecord | null> {
    const record = await this.projects.findOneAndUpdate(
      { _id: projectId, userId },
      { $set: patch },
      { returnDocument: 'after' },
    );
    return record ? withoutMongoId(record) : null;
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    const result = await this.projects.deleteOne({ _id: projectId, userId });
    return result.deletedCount === 1;
  }

  async addSource(
    userId: string,
    projectId: string,
    source: ProjectSource,
    updatedAt: Date,
  ): Promise<ProjectRecord | null> {
    const record = await this.projects.findOneAndUpdate(
      { _id: projectId, userId },
      { $push: { sources: source }, $set: { updatedAt } },
      { returnDocument: 'after' },
    );
    return record ? withoutMongoId(record) : null;
  }

  async removeSource(
    userId: string,
    projectId: string,
    sourceId: string,
    updatedAt: Date,
  ): Promise<ProjectRecord | null> {
    const record = await this.projects.findOneAndUpdate(
      { _id: projectId, userId },
      { $pull: { sources: { id: sourceId } }, $set: { updatedAt } },
      { returnDocument: 'after' },
    );
    return record ? withoutMongoId(record) : null;
  }
}

function withoutMongoId<T extends { _id: string }>(record: T): Omit<T, '_id'> {
  const { _id: _ignored, ...rest } = record;
  return rest;
}
