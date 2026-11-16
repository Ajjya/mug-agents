import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { type EntityId, entityId, toStorage } from '../domain/common.js';
import {
  MessageInputSchema,
  MessagePatchSchema,
  MessageSchema,
  type Message,
  type MessageInput,
  type MessagePatch,
  type MessageStatus,
} from '../domain/message.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from './base.repository.js';

export const MESSAGES_REPOSITORY = Symbol('MESSAGES_REPOSITORY');

/** Drafted speaker messages. No delete: a replaced draft becomes `superseded`. */
export interface MessagesRepository extends Repository<MessageInput, Message, MessagePatch> {
  findByIdempotencyKey(key: string): Promise<Message | null>;
  findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Message>>;
  /** Messages to a speaker for any event with this status (first contact: has anything been sent?). */
  findBySpeakerAndStatus(
    speakerId: EntityId,
    status: MessageStatus,
    options?: FindManyOptions,
  ): Promise<Page<Message>>;
}

@Injectable()
export class MongoMessagesRepository
  extends BaseRepository<typeof MessageInputSchema, typeof MessageSchema, typeof MessagePatchSchema>
  implements MessagesRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.messages), {
      input: MessageInputSchema,
      doc: MessageSchema,
      patch: MessagePatchSchema,
    });
  }

  async findByIdempotencyKey(key: string): Promise<Message | null> {
    const page = await this.findWhere(
      { idempotencyKey: z.string().min(1).parse(key) },
      { limit: 1 },
    );
    return page.items[0] ?? null;
  }

  async findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Message>> {
    return await this.findWhere({ eventId: toStorage(entityId, eventId) }, options);
  }

  async findBySpeakerAndStatus(
    speakerId: EntityId,
    status: MessageStatus,
    options?: FindManyOptions,
  ): Promise<Page<Message>> {
    return await this.findWhere(
      {
        speakerId: toStorage(entityId, speakerId),
        status: MessageInputSchema.shape.status.parse(status),
      },
      options,
    );
  }
}
