import { z } from "zod";

/** The provider, model, reasoning level and service tier an auto-fixer or sent agent runs with. */
export const autoFixerExecutionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.enum([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "none",
      "ultra",
      "ultracode",
    ]),
    serviceTier: z.enum(["fast", "default"]),
  })
  .strict();
