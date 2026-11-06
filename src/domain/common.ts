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

export const entityId = z.codec(
  z.instanceof(ObjectId),
  z.string().regex(/^[0-9a-f]{24}$/i, 'must be a 24-character hex id'),
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
  ...timestampsShape,
} as const;

export type EntityId = z.infer<typeof entityId>;
export type Timestamps = { createdAt: string; updatedAt: string };

/** Non-empty trimmed text, used for names/titles. */
export const nonEmpty = z.string().trim().min(1);

export function newEntityId(): EntityId {
  return new ObjectId().toHexString();
}

/** Converts a domain id string to an ObjectId for use in Mongo filters. */
export function toObjectId(id: EntityId): ObjectId {
  return new ObjectId(id);
}

export function isEntityId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

/** Validate a domain value and convert it to its Mongo representation. Throws ZodError. */
export function toStorage<S extends z.ZodType>(schema: S, value: z.output<S>): z.input<S> {
  return z.encode(schema, value);
}

/** Validate a raw Mongo document and convert it to the domain representation. */
export function fromStorage<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): ReturnType<typeof z.safeParse<S>> {
  return z.safeDecode(schema, raw as z.input<S>) as ReturnType<typeof z.safeParse<S>>;
}
