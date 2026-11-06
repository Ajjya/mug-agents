import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import {
  TaskPatchSchema,
  TaskInputSchema,
  TaskSchema,
  type Task,
  type TaskInput,
  type TaskPatch,
} from '../domain/task.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import { BaseRepository, type Repository } from './base.repository.js';

export const TASKS_REPOSITORY = Symbol('TASKS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export type TasksRepository = Repository<TaskInput, Task, TaskPatch>;

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
}
