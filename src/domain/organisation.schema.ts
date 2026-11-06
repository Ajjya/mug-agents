import { z } from 'zod';
import { documentShape, entityId, nonEmpty } from './common.js';

export const ORGANISATION_KINDS = ['venue', 'sponsor', 'user_group', 'company'] as const;
export const ORGANISATION_EVENT_ROLES = ['venue', 'co_host', 'sponsor'] as const;

export const ContactSchema = z
  .object({
    name: nonEmpty,
    email: z.email().optional(),
    role: nonEmpty.optional(),
  })
  .strict();

export const OrganisationHistoryItemSchema = z
  .object({
    eventId: entityId,
    role: z.enum(ORGANISATION_EVENT_ROLES),
    notes: z.string().optional(),
  })
  .strict();

export const OrganisationInputSchema = z
  .object({
    name: nonEmpty,
    kind: z.enum(ORGANISATION_KINDS),
    contacts: z.array(ContactSchema),
    capacity: z.number().int().positive().optional(),
    address: z.string().optional(),
    history: z.array(OrganisationHistoryItemSchema),
    notes: z.string().optional(),
  })
  .strict();

export const OrganisationSchema = OrganisationInputSchema.extend(documentShape);
export const OrganisationPatchSchema = OrganisationInputSchema.partial();

export type OrganisationKind = (typeof ORGANISATION_KINDS)[number];
export type OrganisationEventRole = (typeof ORGANISATION_EVENT_ROLES)[number];
export type OrganisationInput = z.infer<typeof OrganisationInputSchema>;
export type Organisation = z.infer<typeof OrganisationSchema>;
export type OrganisationPatch = z.infer<typeof OrganisationPatchSchema>;
