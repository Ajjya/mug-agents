import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

/**
 * Autonomy policy: agents never delete. Two ways code under src/ could delete are banned:
 *  1. a driver delete call (`coll.deleteOne(...)`, `db.dropDatabase()`, ...), or the same operation
 *     smuggled through `bulkWrite` as an operation object (`{ deleteMany: { filter } }`);
 *  2. an exported helper whose name starts with delete, remove or drop, i.e. a delete API other modules could call.
 * A domain method that merely has such a name (`deleteDraftFlag()` flips a flag) is deliberately NOT
 * matched: it is neither a driver call nor an exported helper. Plain `bulkWrite` is allowed because
 * inserts and updates through it are fine; only its delete operations are caught, by pattern 1.
 */
export const DRIVER_DELETE_CALL =
  /\.\s*(deleteOne|deleteMany|findOneAndDelete|dropCollection|dropDatabase|dropIndexes?|drop)\s*\(/;
export const DRIVER_DELETE_OPERATION = /\b(deleteOne|deleteMany)\s*:/;
export const EXPORTED_DELETE_HELPER =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var)\s+(?:delete|remove|drop)\w*/;

export const BANNED = [DRIVER_DELETE_CALL, DRIVER_DELETE_OPERATION, EXPORTED_DELETE_HELPER];

export const isBanned = (source: string): boolean => BANNED.some((re) => re.test(source));

describe('autonomy policy: agents never delete', () => {
  it('src contains no delete helpers or driver delete calls', () => {
    const offenders = [...sourceFiles('src')].filter((f) => isBanned(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  describe('the matcher itself', () => {
    it.each([
      ['deleteOne', 'await this.collection.deleteOne({ _id });'],
      ['deleteMany', 'await col.deleteMany({});'],
      ['findOneAndDelete', 'col.findOneAndDelete({ a: 1 })'],
      ['dropDatabase', 'await db.dropDatabase();'],
      ['dropCollection', 'await db.dropCollection("x");'],
      ['drop on a collection', 'await db.collection("x").drop();'],
      ['a delete smuggled through bulkWrite', 'col.bulkWrite([{ deleteOne: { filter: {} } }])'],
      ['an exported delete helper', 'export async function deleteEverything() {}'],
      ['an exported remove helper', 'export const removeTask = () => 1;'],
      ['an exported drop helper', 'export function dropTable() {}'],
    ])('catches %s', (_name, source) => {
      expect(isBanned(source)).toBe(true);
    });

    it.each([
      [
        'a domain method that only has a delete-ish name',
        'class A { deleteDraftFlag() { this.flag = false; } }',
      ],
      ['calling that method', 'this.deleteDraftFlag();'],
      ['an exported class with such a method', 'export class Drafts { removeDraftNote() {} }'],
      ['an unexported local helper', 'function dropDuplicates(xs: string[]) { return xs; }'],
      [
        'bulkWrite with inserts and updates only',
        'col.bulkWrite([{ insertOne: { document: {} } }, { updateOne: { filter: {}, update: {} } }])',
      ],
      ['updateOne', 'await col.updateOne({}, { $set: {} });'],
    ])('does not trip on %s', (_name, source) => {
      expect(isBanned(source)).toBe(false);
    });
  });
});
