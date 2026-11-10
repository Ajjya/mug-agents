import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { type EntityId, entityId, isoDate, toStorage } from '../domain/common.js';
import {
  TaskInputSchema,
  TaskPatchSchema,
  TaskSchema,
  type Task,
  type TaskInput,
  type TaskPatch,
  type TaskStatus,
} from '../domain/task.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from './base.repository.js';

export const TASKS_REPOSITORY = Symbol('TASKS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export interface TasksRepository extends Repository<TaskInput, Task, TaskPatch> {
  findByStatus(status: TaskStatus, options?: FindManyOptions): Promise<Page<Task>>;
  /** Tasks of any status with `dueAt < iso`. Tasks without a `dueAt` never match. */
  findDueBefore(iso: string, options?: FindManyOptions): Promise<Page<Task>>;
  /** Tasks linked to an event (`relatedEventId`), any status. */
  findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Task>>;
}

@Injectable()
export class MongoTasksRepository
  extends BaseRepository<typeof TaskInputSchema, typeof TaskSchema, typeof TaskPatchSchema>
  implements TasksRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.tasks), {
      input: TaskInputSchema,
      doc: TaskSchema,
      patch: TaskPatchSchema,
    });
  }

  async findByStatus(status: TaskStatus, options?: FindManyOptions): Promise<Page<Task>> {
    return await this.findWhere({ status: TaskInputSchema.shape.status.parse(status) }, options);
  }

  async findDueBefore(iso: string, options?: FindManyOptions): Promise<Page<Task>> {
    return await this.findWhere({ dueAt: { $lt: toStorage(isoDate, iso) } }, options);
  }

  async findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Task>> {
    return await this.findWhere({ relatedEventId: toStorage(entityId, eventId) }, options);
  }
}
