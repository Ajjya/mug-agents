import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CandidateThreadInputSchema,
  InboundMessageViewSchema,
} from '../../src/domain/inbox.schema.js';
import type {
  CandidateThreadsRepository,
  InboundMessagesRepository,
} from '../../src/inbox/repositories.js';
import { inboundInput } from './inbox-fixtures.js';

export function inboundMessagesContract(create: () => Promise<InboundMessagesRepository>): void {
  describe('inbound messages repository contract', () => {
    let repo: InboundMessagesRepository;
    beforeEach(async () => {
      repo = await create();
    });

    it('a second insert of the same gmailId is a no-op that returns the stored message', async () => {
      const a = await repo.insert(inboundInput());
      const b = await repo.insert(inboundInput({ subject: 'Different subject' }));
      expect([a.created, b.created]).toEqual([true, false]);
      expect(b.message._id).toBe(a.message._id);
      expect(b.message.subject).toBe('Re: Winter Meetup'); // the stored one, not the retry
      expect(await repo.count()).toBe(1);
    });

    it('NO read returns the body: the view has no bodyText, whatever the method', async () => {
      const { message } = await repo.insert(inboundInput({ bodyText: 'SECRET-BODY-TEXT' }));
      const reads = [
        message,
        await repo.findById(message._id),
        await repo.findByGmailId('g-1'),
        (await repo.findByThreadId('t-1'))[0],
        (await repo.findByTriageState('pending', 10))[0],
        (await repo.findRecent(10))[0],
        await repo.update(message._id, { triageState: 'done' }),
      ];
      for (const r of reads) {
        expect(r).toBeDefined();
        expect(JSON.stringify(r)).not.toContain('SECRET-BODY-TEXT');
        expect(r).not.toHaveProperty('bodyText');
        expect(InboundMessageViewSchema.shape).not.toHaveProperty('bodyText');
      }
    });

    it('getRawBody is the one door to the body', async () => {
      const { message } = await repo.insert(inboundInput({ bodyText: 'the full body' }));
      expect(await repo.getRawBody(message._id)).toBe('the full body');
      expect(await repo.getRawBody('f'.repeat(24))).toBeNull();
      expect(await repo.getRawBody('nope')).toBeNull();
    });

    it('stores the Message-ID, label ids, attachments and addresses lower-cased', async () => {
      const { message } = await repo.insert(
        inboundInput({
          from: { address: 'Mixed.Case@Speakers.Invalid' },
          attachments: [{ filename: 'bio.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }],
        }),
      );
      expect(message.from.address).toBe('mixed.case@speakers.invalid');
      expect(message.rfcMessageId).toBe('<abc@mail.invalid>');
      expect(message.labelIds).toEqual(['Label_mug']);
      expect(message.attachments).toEqual([
        { filename: 'bio.pdf', mimeType: 'application/pdf', sizeBytes: 1234 },
      ]);
      expect(message.classification).toBe('personal');
    });

    it('refuses an unknown field and a classification other than personal', async () => {
      await expect(repo.insert({ ...inboundInput(), surprise: 1 } as never)).rejects.toBeInstanceOf(
        z.ZodError,
      );
      await expect(
        repo.insert(inboundInput({ classification: 'public' as never })),
      ).rejects.toBeInstanceOf(z.ZodError);
    });

    it('only triage and link fields can change after creation', async () => {
      const { message } = await repo.insert(inboundInput());
      const done = await repo.update(message._id, {
        triageState: 'done',
        linkState: 'auto',
        linkedSpeakerId: 'a'.repeat(24),
      });
      expect(done).toMatchObject({ triageState: 'done', linkState: 'auto', version: 2 });
      await expect(
        repo.update(message._id, { subject: 'rewritten' } as never),
      ).rejects.toBeInstanceOf(z.ZodError);
    });

    it('knownGmailIds says which are already stored (the sweep diff)', async () => {
      await repo.insert(inboundInput({ gmailId: 'g-1' }));
      await repo.insert(inboundInput({ gmailId: 'g-2' }));
      expect([...(await repo.knownGmailIds(['g-1', 'g-3', 'g-2']))].sort()).toEqual(['g-1', 'g-2']);
      expect((await repo.knownGmailIds([])).size).toBe(0);
    });
  });
}

export function candidateThreadsContract(create: () => Promise<CandidateThreadsRepository>): void {
  describe('candidate threads', () => {
    it('has no field that could hold a body, and refuses one', async () => {
      expect(Object.keys(CandidateThreadInputSchema.shape).sort()).toEqual([
        'decidedAt',
        'from',
        'lastSeenAt',
        'reason',
        'state',
        'subject',
        'threadId',
      ]);
      const repo = await create();
      const input = {
        threadId: 't-9',
        subject: 'MongoDB newsletter',
        from: { address: 'news@vendor.invalid' },
        lastSeenAt: '2026-11-01T10:00:00.000Z',
        state: 'pending' as const,
      };
      for (const extra of ['body', 'bodyText', 'snippet', 'bodySnippet', 'text']) {
        await expect(repo.insert({ ...input, [extra]: 'leak' })).rejects.toBeInstanceOf(
          z.ZodError,
        );
      }
      const stored = await repo.insert(input);
      expect(stored.state).toBe('pending');
      await expect(repo.insert(input)).rejects.toThrow(/Duplicate key/); // one record per thread
    });
  });
}
