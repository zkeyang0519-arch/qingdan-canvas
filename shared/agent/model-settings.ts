import { z } from "zod";

export const executionSettingsSchema = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._:/-]+$/)
    .optional(),
  fastMode: z.boolean(),
  reasoningEffort: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;
