import { randomUUID } from 'node:crypto';
import type { ProjectRecord, ProjectRepository, ProjectScope, ProjectSource } from './projectRepository.js';

export type PublicProject = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  scope: ProjectScope;
  pinned: boolean;
  shared: boolean;
  sources: Array<{ id: string; name: string; at: string; uri: string }>;
  createdAt: string;
  updatedAt: string;
};

export class ProjectError extends Error {
  constructor(readonly code: 'PROJECT_NOT_FOUND', message: string, readonly statusCode: 404) {
    super(message);
    this.name = 'ProjectError';
  }
}

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async list(userId: string): Promise<PublicProject[]> {
    return (await this.repository.listProjects(userId)).map(publicProject);
  }

  async get(userId: string, projectId: string): Promise<PublicProject> {
    const project = await this.repository.findProject(userId, projectId);
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return publicProject(project);
  }

  async create(input: {
    userId: string;
    name: string;
    scope: ProjectScope;
    description?: string;
    instructions?: string;
  }): Promise<PublicProject> {
    const now = new Date();
    return publicProject(
      await this.repository.createProject({
        id: randomUUID(),
        userId: input.userId,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        instructions: input.instructions?.trim() ?? '',
        scope: input.scope,
        pinned: false,
        shared: false,
        sources: [],
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async update(
    userId: string,
    projectId: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'description' | 'instructions' | 'scope' | 'pinned'>>,
  ): Promise<PublicProject> {
    const updated = await this.repository.updateProject(userId, projectId, {
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.description === undefined ? {} : { description: patch.description.trim() }),
      ...(patch.instructions === undefined ? {} : { instructions: patch.instructions.trim() }),
      ...(patch.scope === undefined ? {} : { scope: patch.scope }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      updatedAt: new Date(),
    });
    if (!updated) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return publicProject(updated);
  }

  async delete(userId: string, projectId: string): Promise<void> {
    if (!(await this.repository.deleteProject(userId, projectId))) {
      throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    }
  }

  async addSource(
    userId: string,
    projectId: string,
    input: { name: string; uri?: string },
  ): Promise<PublicProject> {
    const source: ProjectSource = {
      id: randomUUID(),
      name: input.name.trim(),
      at: new Date(),
      uri: input.uri?.trim() ?? '',
    };
    const updated = await this.repository.addSource(userId, projectId, source, new Date());
    if (!updated) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return publicProject(updated);
  }

  async removeSource(userId: string, projectId: string, sourceId: string): Promise<PublicProject> {
    const updated = await this.repository.removeSource(userId, projectId, sourceId, new Date());
    if (!updated) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return publicProject(updated);
  }
}

function publicProject(project: ProjectRecord): PublicProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    scope: project.scope,
    pinned: project.pinned,
    shared: project.shared,
    sources: project.sources.map((source) => ({
      id: source.id,
      name: source.name,
      at: source.at.toISOString(),
      uri: source.uri,
    })),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
