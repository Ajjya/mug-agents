import type { Collection } from 'mongodb';

export interface SpeakerContactsMigration {
  /** `email` moved into `emails`. */
  emailsMoved: number;
  emailsFilled: number;
  handlesFilled: number;
  oldEmailIndexDropped: boolean;
  /** `links.linkedin` moved into `handles.linkedin` (the speaker had none there). */
  linkedinMoved: number;
  /** `links.linkedin` removed because `handles.linkedin` already had a value, which was left alone. */
  linkedinDuplicatesDropped: number;
}

/**
 * One-off and idempotent (safe to run any number of times; a second run changes nothing and reports zeros).
 *
 *  1. speakers used to carry one optional `email`; they now carry `emails: string[]` and `handles: {}`;
 *  2. a LinkedIn URL has one home: `handles` owns everything used to REACH a speaker, `links` keeps only
 *     github and website. `links.linkedin` moves into `handles.linkedin` when handles has none; an existing
 *     `handles.linkedin` is never touched; the old field is unset either way.
 *
 * Nothing else is touched, and nothing is deleted except the old email index and the moved field.
 */
export async function migrateSpeakerContacts(col: Collection): Promise<SpeakerContactsMigration> {
  const moved = await col.updateMany({ email: { $exists: true } }, [
    {
      $set: {
        emails: { $cond: [{ $isArray: '$emails' }, '$emails', ['$email']] },
        handles: { $ifNull: ['$handles', {}] },
      },
    },
    { $unset: 'email' },
  ]);
  const filled = await col.updateMany({ emails: { $exists: false } }, [
    { $set: { emails: [], handles: { $ifNull: ['$handles', {}] } } },
  ]);
  const handles = await col.updateMany({ handles: { $exists: false } }, [
    { $set: { handles: {} } },
  ]);

  const linkedinMoved = await col.countDocuments({
    'links.linkedin': { $exists: true },
    'handles.linkedin': { $exists: false },
  });
  const linkedinAll = await col.countDocuments({ 'links.linkedin': { $exists: true } });
  await col.updateMany({ 'links.linkedin': { $exists: true } }, [
    {
      $set: {
        handles: {
          $mergeObjects: [
            { $ifNull: ['$handles', {}] },
            // an existing handles.linkedin wins; links.linkedin only fills the gap
            { linkedin: { $ifNull: ['$handles.linkedin', '$links.linkedin'] } },
          ],
        },
      },
    },
    { $unset: 'links.linkedin' },
  ]);

  const hadOldIndex = (await col.indexes()).some((i) => i.name === 'speakers_email_unique');
  if (hadOldIndex) await col.dropIndex('speakers_email_unique');
  return {
    emailsMoved: moved.modifiedCount,
    emailsFilled: filled.modifiedCount,
    handlesFilled: handles.modifiedCount,
    oldEmailIndexDropped: hadOldIndex,
    linkedinMoved,
    linkedinDuplicatesDropped: linkedinAll - linkedinMoved,
  };
}
