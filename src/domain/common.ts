import { ObjectId } from 'mongodb';
import { z } from 'zod';

/**
 * Shared primitives and the ONLY place where storage <-> domain conversion happens.
 *
 *  - Domain / API boundary: ids are 24-char hex strings, dates are ISO-8601 strings.
 *  - MongoDB: ids are ObjectId, dates are Date.
 *
 * Both are expressed as Zod codecs whose *input* side is the Mongo type and whose *output*
 * side is the domain type, so `z.infer<typeof Schema>` is the string-based domain type.
 * Use `toStorage` (domain -> Mongo, validating) and `fromStorage` (Mongo -> domain, validating).
 */

export const ENTITY_ID_RE = /^[0-9a-f]{24}$/i;

export const entityId = z.codec(
  z.instanceof(ObjectId),
  z.string().regex(ENTITY_ID_RE, 'must be a 24-character hex id'),
  {
    decode: (oid) => oid.toHexString(),
    encode: (hex) => new ObjectId(hex),
  },
);

export const isoDate = z.codec(z.date(), z.iso.datetime({ offset: true }), {
  decode: (d) => d.toISOString(),
  encode: (iso) => new Date(iso),
});

/** Fields every persisted document carries. Set by the repository, never by the caller. */
export const timestampsShape = {
  createdAt: isoDate,
  updatedAt: isoDate,
} as const;

export const documentShape = {
  _id: entityId,
  /** Optimistic-lock counter: starts at 1, incremented by the repository on every update. */
  version: z.number().int().positive(),
  ...timestampsShape,
} as const;

export type EntityId = z.infer<typeof entityId>;
export type Timestamps = { createdAt: string; updatedAt: string };

/** A string that is not a valid 24-char hex id (distinct from a driver BSONError). */
export class InvalidIdError extends Error {
  constructor(public readonly value: string) {
    super(`Invalid entity id: ${JSON.stringify(value)}`);
    this.name = 'InvalidIdError';
  }
}

/** Non-empty trimmed text, used for names/titles. */
export const nonEmpty = z.string().trim().min(1);

export function newEntityId(): EntityId {
  return new ObjectId().toHexString();
}

/** Converts a domain id string to an ObjectId for use in Mongo filters. */
export function toObjectId(id: EntityId): ObjectId {
  if (!isEntityId(id)) throw new InvalidIdError(id);
  return new ObjectId(id);
}

export function isEntityId(value: string): boolean {
  return ENTITY_ID_RE.test(value);
}

/** Validate a domain value and convert it to its Mongo representation. Throws ZodError. */
export function toStorage<S extends z.ZodType>(schema: S, value: z.output<S>): z.input<S> {
  return z.encode(schema, value);
}

/** Validate a raw Mongo document and convert it to the domain representation. */
export function fromStorage<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): z.ZodSafeParseResult<z.output<S>> {
  return z.safeDecode(schema, raw as z.input<S>);
}
