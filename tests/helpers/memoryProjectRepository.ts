import type { CreateProjectInput, ProjectRecord, ProjectRepository, ProjectSource } from '../../src/modules/projects/projectRepository.js';

export class MemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, ProjectRecord>();

  async ensureIndexes(): Promise<void> {}

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    this.projects.set(input.id, input);
    return input;
  }

  async findProject(userId: string, projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project?.userId === userId ? project : null;
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async updateProject(
    userId: string,
    projectId: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'description' | 'instructions' | 'scope' | 'pinned' | 'updatedAt'>>,
  ): Promise<ProjectRecord | null> {
    const project = await this.findProject(userId, projectId);
    if (!project) return null;
    const updated = { ...project, ...patch };
    this.projects.set(projectId, updated);
    return updated;
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    const project = await this.findProject(userId, projectId);
    if (!project) return false;
    this.projects.delete(projectId);
    return true;
  }

  async addSource(userId: string, projectId: string, source: ProjectSource, updatedAt: Date): Promise<ProjectRecord | null> {
    const project = await this.findProject(userId, projectId);
    if (!project) return null;
    const updated = { ...project, sources: [source, ...project.sources], updatedAt };
    this.projects.set(projectId, updated);
    return updated;
  }

  async removeSource(userId: string, projectId: string, sourceId: string, updatedAt: Date): Promise<ProjectRecord | null> {
    const project = await this.findProject(userId, projectId);
    if (!project) return null;
    const updated = { ...project, sources: project.sources.filter((source) => source.id !== sourceId), updatedAt };
    this.projects.set(projectId, updated);
    return updated;
  }
}
