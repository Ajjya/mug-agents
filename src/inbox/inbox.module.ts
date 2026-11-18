import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { STRUCTURED_CALL } from '../llm/llm.module.js';
import type { StructuredCall } from '../llm/structured.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { EVENTS_REPOSITORY, type EventsRepository } from '../repositories/events.repository.js';
import {
  ORGANISATIONS_REPOSITORY,
  type OrganisationsRepository,
} from '../repositories/organisations.repository.js';
import { RepositoriesModule } from '../repositories/repositories.module.js';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../repositories/speakers.repository.js';
import { TASKS_REPOSITORY, type TasksRepository } from '../repositories/tasks.repository.js';
import { GoogleGmailClient, LazyGmailClient } from './gmail.client.js';
import type { GmailClient } from './gmail.transport.js';
import { type InboxConfig, requireGmailCredentials, resolveInboxConfig } from './inbox.config.js';
import { InboxService } from './inbox.service.js';
import {
  ADMITTED_THREADS_REPOSITORY,
  CANDIDATE_THREADS_REPOSITORY,
  CONTACTS_REPOSITORY,
  EXCLUDED_THREADS_REPOSITORY,
  INBOUND_MESSAGES_REPOSITORY,
  INBOX_CURSOR_REPOSITORY,
  MongoAdmittedThreadsRepository,
  MongoCandidateThreadsRepository,
  MongoContactsRepository,
  MongoExcludedThreadsRepository,
  MongoInboundMessagesRepository,
  MongoInboxCursorRepository,
  type AdmittedThreadsRepository,
  type CandidateThreadsRepository,
  type ContactsRepository,
  type ExcludedThreadsRepository,
  type InboundMessagesRepository,
  type InboxCursorRepository,
} from './repositories.js';
import { Triager } from './triage.js';

export const INBOX_CONFIG = Symbol('INBOX_CONFIG');
export const GMAIL_CLIENT = Symbol('GMAIL_CLIENT');

/**
 * The inbox. It is imported ONLY by the inbox CLI and by tests, never by AppModule, so nothing else
 * boots it, and it validates its configuration when it boots: an unset GMAIL_LABEL or
 * GMAIL_CANDIDATE_LABEL, or the two being equal, fails here (spec 1.4), before any Gmail call can
 * exist. Gmail credentials are demanded lazily, on the first Gmail call, so commands that only read
 * the database (`candidates`, `admit`, `list`) need none.
 */
@Module({
  imports: [MongoModule, RepositoriesModule],
  providers: [
    {
      provide: INBOX_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): InboxConfig => resolveInboxConfig(c),
    },
    { provide: INBOUND_MESSAGES_REPOSITORY, useClass: MongoInboundMessagesRepository },
    { provide: ADMITTED_THREADS_REPOSITORY, useClass: MongoAdmittedThreadsRepository },
    { provide: EXCLUDED_THREADS_REPOSITORY, useClass: MongoExcludedThreadsRepository },
    { provide: CANDIDATE_THREADS_REPOSITORY, useClass: MongoCandidateThreadsRepository },
    { provide: CONTACTS_REPOSITORY, useClass: MongoContactsRepository },
    { provide: INBOX_CURSOR_REPOSITORY, useClass: MongoInboxCursorRepository },
    {
      provide: GMAIL_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): GmailClient =>
        new LazyGmailClient(() => GoogleGmailClient.fromCredentials(requireGmailCredentials(c))),
    },
    {
      provide: InboxService,
      inject: [
        GMAIL_CLIENT,
        INBOUND_MESSAGES_REPOSITORY,
        ADMITTED_THREADS_REPOSITORY,
        EXCLUDED_THREADS_REPOSITORY,
        CANDIDATE_THREADS_REPOSITORY,
        CONTACTS_REPOSITORY,
        INBOX_CURSOR_REPOSITORY,
        SPEAKERS_REPOSITORY,
        EVENTS_REPOSITORY,
        ORGANISATIONS_REPOSITORY,
        TASKS_REPOSITORY,
        STRUCTURED_CALL,
        INBOX_CONFIG,
      ],
      useFactory: (
        gmail: GmailClient,
        inbound: InboundMessagesRepository,
        admitted: AdmittedThreadsRepository,
        excluded: ExcludedThreadsRepository,
        candidates: CandidateThreadsRepository,
        contacts: ContactsRepository,
        cursor: InboxCursorRepository,
        speakers: SpeakersRepository,
        events: EventsRepository,
        organisations: OrganisationsRepository,
        tasks: TasksRepository,
        call: StructuredCall,
        config: InboxConfig,
      ) => {
        const logger = new Logger('Inbox');
        return new InboxService({
          gmail,
          inbound,
          admitted,
          excluded,
          candidates,
          contacts,
          cursor,
          speakers,
          events,
          organisations,
          tasks,
          config,
          triager: new Triager({
            call,
            maxChars: config.triageMaxChars,
            startAt: config.triageStartRung,
          }),
          // Counts and flags only: the service never passes a subject, an address or any text.
          log: (message, fields) => {
            logger.log(message, fields ?? {});
          },
        });
      },
    },
  ],
  exports: [InboxService, INBOX_CONFIG],
})
export class InboxModule {}
