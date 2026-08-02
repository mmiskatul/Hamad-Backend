export const PROJECT_SCOPES = ['default', 'project-only'] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

export type ProjectSource = {
  id: string;
  name: string;
  at: Date;
  uri: string;
};

export type ProjectRecord = {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  scope: ProjectScope;
  pinned: boolean;
  shared: boolean;
  sources: ProjectSource[];
  createdAt: Date;
  updatedAt: Date;
};

export type CreateProjectInput = Omit<ProjectRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};

export interface ProjectRepository {
  ensureIndexes(): Promise<void>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  findProject(userId: string, projectId: string): Promise<ProjectRecord | null>;
  listProjects(userId: string): Promise<ProjectRecord[]>;
  updateProject(
    userId: string,
    projectId: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'description' | 'instructions' | 'scope' | 'pinned' | 'updatedAt'>>,
  ): Promise<ProjectRecord | null>;
  deleteProject(userId: string, projectId: string): Promise<boolean>;
  addSource(userId: string, projectId: string, source: ProjectSource, updatedAt: Date): Promise<ProjectRecord | null>;
  removeSource(userId: string, projectId: string, sourceId: string, updatedAt: Date): Promise<ProjectRecord | null>;
}
