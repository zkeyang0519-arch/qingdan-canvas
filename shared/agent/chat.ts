import { z } from "zod";

export const CHAT_INPUT_LIMIT = 12000;
export const CHAT_CONTEXT_LIMIT = 48000;
export const CHAT_MEMORY_LIMIT = 12;
export const CHAT_HISTORY_LIMIT = 12;
export const agentReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(16000),
  tasks: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(32000),
        instruction: z.string().trim().min(1).max(32000),
        acceptance: z.string().trim().min(1).max(4000),
      }),
    )
    .max(50),
  memories: z
    .array(
      z.strictObject({
        scope: z.enum(["personal", "project"]),
        key: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(1000),
      }),
    )
    .max(12),
});
export type AgentReply = z.infer<typeof agentReplySchema>;
export const agentReplyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "tasks", "memories"],
  properties: {
    text: { type: "string" },
    tasks: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "instruction", "acceptance"],
        properties: {
          text: { type: "string" },
          instruction: { type: "string" },
          acceptance: { type: "string" },
        },
      },
    },
    memories: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "key", "value"],
        properties: {
          scope: { type: "string", enum: ["personal", "project"] },
          key: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  },
} as const;
