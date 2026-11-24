import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTONOMY_ACTIONS } from '../../src/approvals/autonomy.js';
import {
  type PipelineMessage,
  type PipelineSpeaker,
  type PlannedAction,
  RULES,
  decideActions,
} from '../../src/agents/speakers/decide.js';
import { DRAFT_KINDS, MESSAGE_KINDS, MESSAGE_STATUSES } from '../../src/domain/message.schema.js';
import { SPEAKER_STATUSES } from '../../src/domain/speaker.schema.js';
import { buildSpeakersHarness, inMemorySpeakerRepos } from '../support/speakers-harness.js';
import { day, eventMessages, seed } from '../support/speakers-workflow-suite.js';

/**
 * STRUCTURAL GUARANTEE (like test/unit/no-delete.test.ts): the agent never writes the first message to a
 * speaker. This is not a policy that asks for approval; no code path can produce such a message, and these
 * tests fail if one appears. Three independent layers:
 *   1. the types: nothing the agent plans or drafts can be an `invitation`;
 *   2. decideActions: a speaker with no sent message of ours, for any event, gets nothing, whatever the
 *      status, the date, the policy or the pending messages;
 *   3. the store: a draft for such a speaker is refused at the write.
 */

const EVENT = '2026-12-12T00:00:00.000Z';
const POLICY = { chaseMaxRounds: 2, chaseMinIntervalDays: 7, maxDraftsPerRun: 1000 };
const S = 's'.repeat(24);

describe('layer 1: the types and the table', () => {
  it('no rule can produce an invitation, and none starts from idea', () => {
    expect(RULES.map((r) => r.kind as string)).not.toContain('invitation');
    expect(RULES.map((r) => r.status as string)).not.toContain('idea');
    expect(DRAFT_KINDS as readonly string[]).not.toContain('invitation');
    expect(MESSAGE_KINDS as readonly string[]).toContain('invitation'); // recordable by you, never drafted
  });

  it('an invitation is not a PlannedAction (this line fails to COMPILE if it ever is)', () => {
    const bad: PlannedAction = {
      speakerId: S,
      // @ts-expect-error the agent cannot plan an invitation
      kind: 'invitation',
      round: 1,
      reason: 'x',
      dueOn: '2026-11-01',
    };
    expect(bad.kind).toBe('invitation');
  });

  it('there is no first-contact entry in the autonomy table: it is structural, not an approval', () => {
    expect(AUTONOMY_ACTIONS as readonly string[]).not.toContain('first_contact_message');
  });
});

describe('layer 2: decideActions emits nothing for a speaker with no sent message, ever', () => {
  const speaker = (status: PipelineSpeaker['status'], over: Partial<PipelineSpeaker>) => ({
    id: S,
    name: 'Ana Pires',
    status,
    hasPriorSent: false,
    hasBio: false,
    hasPhoto: false,
    ...over,
  });
  const pendingOf = (): PipelineMessage[] =>
    DRAFT_KINDS.flatMap((kind) =>
      MESSAGE_STATUSES.map((status, i) => ({
        id: `${kind}-${status}`,
        speakerId: S,
        kind,
        round: i + 1,
        status,
      })),
    );

  it('every status x every day from T-60 to T+10 x with and without stray messages: no action', () => {
    let checked = 0;
    for (const status of SPEAKER_STATUSES) {
      for (let offset = -60; offset <= 10; offset++) {
        const now = new Date(Date.parse(EVENT) + offset * 86_400_000 + 9.5 * 3_600_000);
        for (const messages of [[], pendingOf()]) {
          for (const lastInboundAt of [undefined, '2026-11-01T00:00:00.000Z']) {
            const d = decideActions({
              now,
              eventDate: EVENT,
              speakers: [
                speaker(status, {
                  ...(lastInboundAt ? { lastInboundAt } : {}),
                  statusSince: '2026-09-01T00:00:00.000Z',
                }),
              ],
              messages,
              policy: POLICY,
            });
            expect(d.actions, `${status} at ${String(offset)}`).toEqual([]);
            expect(d.deferred).toEqual([]);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(SPEAKER_STATUSES.length * 71 * 2 * 2);
  });

  it('the same speaker WITH a sent message is chased: the guard is the missing conversation, not a switch-off', () => {
    const d = decideActions({
      now: new Date('2026-11-21T09:30:00.000Z'),
      eventDate: EVENT,
      speakers: [speaker('confirmed', { hasPriorSent: true })],
      messages: [],
      policy: POLICY,
    });
    expect(d.actions.map((a) => a.kind)).toEqual(['chase_abstract', 'chase_bio', 'chase_photo']);
  });

  it('and says why, so it is not silent', () => {
    const d = decideActions({
      now: new Date('2026-11-20T09:30:00.000Z'),
      eventDate: EVENT,
      speakers: [speaker('confirmed', {})],
      messages: [],
      policy: POLICY,
    });
    expect(d.waiting[0]?.why).toMatch(/no message of ours has ever been sent/);
  });
});

describe('layer 3: the store refuses a draft for a speaker we have never written to', () => {
  it('upsertDraft throws, and nothing is stored, whatever called it', async () => {
    const repos = inMemorySpeakerRepos();
    const s = await seed(repos, [{ name: 'Ana Pires', status: 'confirmed' }]); // not contacted
    const h = buildSpeakersHarness(repos);
    await expect(
      h.store.upsertDraft({
        eventId: s.eventId,
        speakerId: s.speakers['Ana Pires'] ?? '',
        kind: 'chase_abstract',
        round: 1,
        reason: 'x',
        subject: 's',
        body: 'b',
        facts: {},
        needsApproval: false,
        channel: 'email',
      }),
    ).rejects.toThrow(/no message of ours has ever been sent/);
    expect(await eventMessages(h, s.eventId)).toEqual([]);
  });

  it('end to end: a confirmed speaker nobody has written to produces no draft and no model call', async () => {
    const repos = inMemorySpeakerRepos();
    const s = await seed(repos, [{ name: 'Ana Pires', status: 'confirmed' }]);
    const h = buildSpeakersHarness(repos);
    await h.service.run(s.eventId, { now: day('2026-11-20') });
    expect(await eventMessages(h, s.eventId)).toEqual([]);
    expect(h.model.prompts).toHaveLength(0);
  });
});

describe('source scan: nothing under src/agents assigns kind: invitation', () => {
  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* files(path);
      else if (path.endsWith('.ts')) yield path;
    }
  }
  const ASSIGNS_INVITATION = /\bkind\s*:\s*['"`]invitation['"`]/;
  it('no agent code constructs an invitation', () => {
    const offenders = [...files('src/agents')].filter((f) =>
      ASSIGNS_INVITATION.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
  it.each([
    ["{ kind: 'invitation', round: 1 }", true],
    ["m.kind === 'invitation'", false],
    ["kind: 'chase_reply'", false],
  ])('the matcher: %s', (source, hit) => {
    expect(ASSIGNS_INVITATION.test(source)).toBe(hit);
  });
});
