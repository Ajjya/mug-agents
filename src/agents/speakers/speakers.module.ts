import { Module } from '@nestjs/common';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Db } from 'mongodb';
import { APPROVALS_GATE, ApprovalsStoreModule } from '../../approvals/approvals-store.module.js';
import {
  APPROVAL_DECISIONS_REPOSITORY,
  APPROVAL_REQUESTS_REPOSITORY,
  type ApprovalDecisionsRepository,
  type ApprovalRequestsRepository,
} from '../../approvals/approvals.repository.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import {
  CHECKPOINTER,
  CHECKPOINT_RETENTION,
  CheckpointerModule,
} from '../../graph/checkpointer.module.js';
import type { CheckpointRetention } from '../../graph/retention.js';
import { MongoThreadLock } from '../../graph/thread-lock.js';
import { STRUCTURED_CALL } from '../../llm/llm.module.js';
import type { StructuredCall } from '../../llm/structured.js';
import { MongoModule } from '../../mongo/mongo.module.js';
import { MONGO_DB } from '../../mongo/tokens.js';
import { EVENTS_REPOSITORY, type EventsRepository } from '../../repositories/events.repository.js';
import {
  MESSAGES_REPOSITORY,
  type MessagesRepository,
} from '../../repositories/messages.repository.js';
import {
  ORGANISATIONS_REPOSITORY,
  type OrganisationsRepository,
} from '../../repositories/organisations.repository.js';
import { RepositoriesModule } from '../../repositories/repositories.module.js';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../../repositories/speakers.repository.js';
import { TASKS_REPOSITORY, type TasksRepository } from '../../repositories/tasks.repository.js';
import { RetrievalModule } from '../../retrieval/retrieval.module.js';
import { RetrievalService } from '../../retrieval/retrieval.service.js';
import type { ApprovalGate } from '../planner/planner.graph.js';
import type { ChasePolicy } from './decide.js';
import { RetrievalDraftContext } from './retrieval-context.js';
import { buildSpeakersGraph } from './speakers.graph.js';
import { SpeakersRuntime } from './speakers.runtime.js';
import { SpeakersService } from './speakers.service.js';
import { SpeakerPipelineStore } from './speakers.store.js';

export const SPEAKERS_RUNTIME = Symbol('SPEAKERS_RUNTIME');
export const SPEAKER_PIPELINE_STORE = Symbol('SPEAKER_PIPELINE_STORE');

const policyOf = (c: AppConfig): ChasePolicy => ({
  chaseMaxRounds: c.CHASE_MAX_ROUNDS,
  chaseMinIntervalDays: c.CHASE_MIN_INTERVAL_DAYS,
  maxDraftsPerRun: c.MAX_DRAFTS_PER_RUN,
});

@Module({
  imports: [
    MongoModule,
    RepositoriesModule,
    ApprovalsStoreModule,
    CheckpointerModule,
    RetrievalModule,
  ],
  providers: [
    {
      provide: SPEAKER_PIPELINE_STORE,
      inject: [
        EVENTS_REPOSITORY,
        SPEAKERS_REPOSITORY,
        ORGANISATIONS_REPOSITORY,
        MESSAGES_REPOSITORY,
        TASKS_REPOSITORY,
        APP_CONFIG,
      ],
      useFactory: (
        events: EventsRepository,
        speakers: SpeakersRepository,
        organisations: OrganisationsRepository,
        messages: MessagesRepository,
        tasks: TasksRepository,
        c: AppConfig,
      ) =>
        new SpeakerPipelineStore(
          events,
          speakers,
          organisations,
          messages,
          tasks,
          c.APPROVER_NAME ?? 'organiser',
        ),
    },
    {
      provide: SPEAKERS_RUNTIME,
      inject: [
        STRUCTURED_CALL,
        APPROVALS_GATE,
        SPEAKER_PIPELINE_STORE,
        RetrievalService,
        CHECKPOINTER,
        CHECKPOINT_RETENTION,
        MONGO_DB,
        APP_CONFIG,
      ],
      useFactory: (
        call: StructuredCall,
        gate: ApprovalGate,
        store: SpeakerPipelineStore,
        retrieval: RetrievalService,
        checkpointer: BaseCheckpointSaver,
        retention: CheckpointRetention,
        db: Db,
        c: AppConfig,
      ) =>
        new SpeakersRuntime(
          buildSpeakersGraph(
            {
              call,
              gate,
              store,
              context: new RetrievalDraftContext(retrieval),
              policy: policyOf(c),
              timeZone: c.EVENT_TIME_ZONE,
            },
            checkpointer,
          ),
          retention,
          new MongoThreadLock(db),
        ),
    },
    {
      provide: SpeakersService,
      inject: [
        SPEAKER_PIPELINE_STORE,
        SPEAKERS_RUNTIME,
        APPROVAL_REQUESTS_REPOSITORY,
        APPROVAL_DECISIONS_REPOSITORY,
        APP_CONFIG,
      ],
      useFactory: (
        store: SpeakerPipelineStore,
        runtime: SpeakersRuntime,
        requests: ApprovalRequestsRepository,
        decisions: ApprovalDecisionsRepository,
        c: AppConfig,
      ) => new SpeakersService(store, runtime, requests, decisions, policyOf(c)),
    },
  ],
  exports: [SpeakersService, SPEAKERS_RUNTIME],
})
export class SpeakersModule {}
