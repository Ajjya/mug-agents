import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module.js';
import { EVENTS_REPOSITORY, MongoEventsRepository } from './events.repository.js';
import {
  MongoOrganisationsRepository,
  ORGANISATIONS_REPOSITORY,
} from './organisations.repository.js';
import { MongoSpeakersRepository, SPEAKERS_REPOSITORY } from './speakers.repository.js';
import { MongoTasksRepository, TASKS_REPOSITORY } from './tasks.repository.js';

@Module({
  imports: [MongoModule],
  providers: [
    { provide: EVENTS_REPOSITORY, useClass: MongoEventsRepository },
    { provide: SPEAKERS_REPOSITORY, useClass: MongoSpeakersRepository },
    { provide: ORGANISATIONS_REPOSITORY, useClass: MongoOrganisationsRepository },
    { provide: TASKS_REPOSITORY, useClass: MongoTasksRepository },
  ],
  exports: [EVENTS_REPOSITORY, SPEAKERS_REPOSITORY, ORGANISATIONS_REPOSITORY, TASKS_REPOSITORY],
})
export class RepositoriesModule {}
