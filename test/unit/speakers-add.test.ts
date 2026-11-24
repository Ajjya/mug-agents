import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../../src/agents/speakers/transitions.js';
import {
  SpeakerNotFoundError,
  SpeakerNotInEventError,
} from '../../src/agents/speakers/speakers.store.js';
import { EventNotFoundError } from '../../src/agents/planner/plan-persistence.js';
import { buildSpeakersHarness, inMemorySpeakerRepos } from '../support/speakers-harness.js';
import { day } from '../support/speakers-workflow-suite.js';

/** The entry point of the whole agent: a speaker has NO perEvent entry until you add one. */
async function world() {
  const repos = inMemorySpeakerRepos();
  const h = buildSpeakersHarness(repos);
  const event = await repos.events.insert({
    title: 'MUG Winter Meetup',
    phase: 'planning',
    date: '2026-12-12T00:00:00.000Z',
    coHostOrganisationIds: [],
    agenda: [],
  });
  const other = await repos.events.insert({
    title: 'Spring Meetup',
    phase: 'planning',
    date: '2027-04-10T00:00:00.000Z',
    coHostOrganisationIds: [],
    agenda: [],
  });
  const mk = async (handle: string, name: string) =>
    await repos.speakers.insert({
      handle,
      name,
      emails: [],
      handles: { linkedin: `https://linkedin.com/in/${handle}` },
      topics: [],
      links: {},
      perEvent: [], // exactly what a seeded speaker looks like
    });
  const ana = await mk('ana-pires', 'Ana Pires');
  const rui = await mk('rui-alves', 'Rui Alves');
  const eva = await mk('eva-costa', 'Eva Costa');
  return { repos, h, event, other, ana, rui, eva };
}

describe('speakers add', () => {
  it('creates ONE entry, with status idea by default', async () => {
    const { repos, h, event, ana } = await world();
    const r = await h.service.addToEvent([ana._id], event._id, undefined, day('2026-10-01'));
    expect(r.added.map((s) => s._id)).toEqual([ana._id]);
    expect(r.existed).toEqual([]);
    expect((await repos.speakers.findById(ana._id))?.perEvent).toEqual([
      { eventId: event._id, status: 'idea', updatedAt: day('2026-10-01').toISOString() },
    ]);
  });

  it('twice creates one, reports that it already existed, and leaves the entry exactly as it was', async () => {
    const { repos, h, event, ana } = await world();
    await h.service.addToEvent([ana._id], event._id, 'idea', day('2026-10-01'));
    // the entry moved on in between: a second add must not reset it
    await h.service.setStatus(ana._id, event._id, 'invited', day('2026-10-05'));
    const again = await h.service.addToEvent([ana._id], event._id, 'idea', day('2026-10-09'));
    expect(again.added).toEqual([]);
    expect(again.existed.map((e) => [e.speaker._id, e.status])).toEqual([[ana._id, 'invited']]);
    const perEvent = (await repos.speakers.findById(ana._id))?.perEvent ?? [];
    expect(perEvent).toHaveLength(1);
    expect(perEvent[0]).toMatchObject({
      status: 'invited',
      updatedAt: day('2026-10-05').toISOString(),
    });
  });

  it('status --set then works on it (and still refuses where there is no entry)', async () => {
    const { h, event, other, ana, rui } = await world();
    await expect(h.service.setStatus(ana._id, event._id, 'invited')).rejects.toBeInstanceOf(
      SpeakerNotInEventError,
    ); // before add: refused, as today
    await h.service.addToEvent([ana._id], event._id, 'idea');
    expect(await h.service.setStatus(ana._id, event._id, 'invited')).toEqual({
      from: 'idea',
      to: 'invited',
    });
    await expect(h.service.setStatus(ana._id, other._id, 'invited')).rejects.toBeInstanceOf(
      SpeakerNotInEventError,
    ); // an entry for one event is not an entry for another
    await expect(h.service.setStatus(rui._id, event._id, 'invited')).rejects.toBeInstanceOf(
      SpeakerNotInEventError,
    );
  });

  it('--speakers adds a shortlist in one go, by id or by seeded handle, and tolerates repeats', async () => {
    const { repos, h, event, ana, rui, eva } = await world();
    const r = await h.service.addToEvent(
      [ana._id, 'rui-alves', eva._id, ana._id],
      event._id,
      'idea',
    );
    expect(r.added.map((s) => s.name).sort()).toEqual(['Ana Pires', 'Eva Costa', 'Rui Alves']);
    for (const s of [ana, rui, eva])
      expect((await repos.speakers.findById(s._id))?.perEvent).toHaveLength(1);
  });

  it('may start someone at a later status (already invited, say)', async () => {
    const { repos, h, event, ana } = await world();
    await h.service.addToEvent([ana._id], event._id, 'invited');
    expect((await repos.speakers.findById(ana._id))?.perEvent[0]?.status).toBe('invited');
  });

  it('refuses an unknown speaker or event with a clear message, and writes NOTHING (not even for the known ones)', async () => {
    const { repos, h, event, ana } = await world();
    await expect(
      h.service.addToEvent([ana._id, 'nobody-here', 'f'.repeat(24)], event._id),
    ).rejects.toThrow(/No speaker "nobody-here", "f{24}".*speaker id.*seeded handle/);
    await expect(h.service.addToEvent([ana._id], 'f'.repeat(24))).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    await expect(h.service.addToEvent([ana._id], 'not-an-id')).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    await expect(h.service.addToEvent(['nobody'], event._id)).rejects.toBeInstanceOf(
      SpeakerNotFoundError,
    );
    expect((await repos.speakers.findById(ana._id))?.perEvent).toEqual([]);
  });

  it('list shows the shortlist, idea included, before the agent runs; another event stays empty', async () => {
    const { h, event, other, ana, rui, eva } = await world();
    await h.service.addToEvent([ana._id, rui._id], event._id, 'idea');
    await h.service.addToEvent([eva._id], event._id, 'invited');
    const listed = await h.service.list(event._id, day('2026-11-01'));
    expect(listed.rows.map((r) => [r.name, r.status]).sort()).toEqual([
      ['Ana Pires', 'idea'],
      ['Eva Costa', 'invited'],
      ['Rui Alves', 'idea'],
    ]);
    // an idea speaker at T-6w is shown as the task it will become
    expect(listed.rows.find((r) => r.name === 'Ana Pires')?.next).toMatch(/reach out/);
    expect((await h.service.list(other._id, day('2026-11-01'))).rows).toEqual([]);
  });

  it('the agent now has something to do: run creates the reach-out task for an added idea speaker', async () => {
    const { repos, h, event, ana } = await world();
    await h.service.addToEvent([ana._id], event._id);
    await h.service.run(event._id, { now: day('2026-10-31') });
    expect((await repos.tasks.findByEventId(event._id)).items.map((t) => t.title)).toEqual([
      'Reach out to Ana Pires about MUG Winter Meetup',
    ]);
  });
});

describe('speakers remove is NOT a delete', () => {
  it('sets the entry to declined with the reason, and keeps the entry and its history', async () => {
    const { repos, h, event, ana } = await world();
    await h.service.addToEvent([ana._id], event._id);
    const r = await h.service.removeFromEvent(
      ana._id,
      event._id,
      'cannot make the date',
      day('2026-10-20'),
    );
    expect(r).toMatchObject({ from: 'idea', alreadyDeclined: false });
    const perEvent = (await repos.speakers.findById(ana._id))?.perEvent ?? [];
    expect(perEvent).toHaveLength(1); // still there
    expect(perEvent[0]).toMatchObject({
      status: 'declined',
      statusReason: 'cannot make the date',
      updatedAt: day('2026-10-20').toISOString(),
    });
    // and it is reversible the normal way, which clears the old reason
    await h.service.setStatus(ana._id, event._id, 'idea', day('2026-10-25'));
    expect((await repos.speakers.findById(ana._id))?.perEvent[0]).not.toHaveProperty(
      'statusReason',
    );
  });

  it('is idempotent, and works from invited and confirmed', async () => {
    const { h, event, ana, rui } = await world();
    await h.service.addToEvent([ana._id], event._id, 'confirmed');
    await h.service.addToEvent([rui._id], event._id, 'invited');
    expect(await h.service.removeFromEvent(ana._id, event._id, 'x')).toMatchObject({
      from: 'confirmed',
    });
    expect(await h.service.removeFromEvent(ana._id, event._id, 'x')).toMatchObject({
      alreadyDeclined: true,
    });
    expect(await h.service.removeFromEvent('rui-alves', event._id, 'y')).toMatchObject({
      from: 'invited',
    });
  });

  it('goes through the transition guard: it refuses where declining is no longer possible, and where there is no entry or no such speaker', async () => {
    const { h, event, ana, rui } = await world();
    await h.service.addToEvent([ana._id], event._id, 'slides_received');
    await expect(h.service.removeFromEvent(ana._id, event._id, 'x')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(h.service.removeFromEvent(rui._id, event._id, 'x')).rejects.toBeInstanceOf(
      SpeakerNotInEventError,
    );
    await expect(h.service.removeFromEvent('nobody', event._id, 'x')).rejects.toBeInstanceOf(
      SpeakerNotFoundError,
    );
  });

  it('a declined speaker is chased no further: the agent supersedes what was pending and drafts nothing', async () => {
    const { repos, h, event, ana } = await world();
    await h.service.addToEvent([ana._id], event._id, 'confirmed');
    await repos.messages.insert({
      eventId: event._id,
      speakerId: ana._id,
      kind: 'thank_you',
      channel: 'email',
      round: 1,
      subject: 's',
      body: 'b',
      facts: {},
      reason: 'earlier',
      needsApproval: false,
      status: 'sent',
      idempotencyKey: `${event._id}:${ana._id}:thank_you:1`,
      sentAt: '2026-04-19T10:00:00.000Z',
    });
    await h.service.removeFromEvent(ana._id, event._id, 'gone');
    const r = await h.service.run(event._id, { now: day('2026-11-20') });
    expect(r.created).toEqual([]);
  });
});
