import { z } from "zod";
import { acceptanceCriterionSchema } from "./schemas";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x20\x7f]+$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const generation = revision.min(1);
const taskFields = { noteId: id, taskId: id };
const specFields = {
  instruction: z.string().trim().max(32000),
  acceptance: z.string().trim().max(4000),
  acceptanceChecks: z
    .array(acceptanceCriterionSchema)
    .max(50)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Duplicate acceptance identifiers",
    )
    .refine(
      (items) => items.length === 0 || items.some((item) => item.required),
      "A required check is needed",
    )
    .optional(),
};
const text = z.string().trim().min(1).max(32000);
export const checklistCreateTasksSchema = z
  .array(z.strictObject({ text, ...specFields }))
  .min(1)
  .max(50);
export const checklistMutationSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("create"),
      requestId: id,
      tasks: checklistCreateTasksSchema,
      targetNoteId: id.optional(),
      expectedNoteRevision: generation.optional(),
    })
    .refine((v) => !!v.targetNoteId === (v.expectedNoteRevision !== undefined)),
  z.strictObject({
    action: z.literal("save"),
    requestId: id,
    ...taskFields,
    expectedGeneration: generation,
    expectedSpecRevision: revision,
    text: text.optional(),
    ...specFields,
  }),
  z.strictObject({
    action: z.literal("reorder"),
    requestId: id,
    expectedSequence: revision,
    order: z.array(z.strictObject(taskFields)).min(1).max(200),
  }),
]);
