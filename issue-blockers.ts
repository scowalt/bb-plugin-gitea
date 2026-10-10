import { z } from "zod";

export const issueBlockerStateSchema = z.enum(["blocked", "unblocked", "unknown"]);
export type IssueBlockerState = z.infer<typeof issueBlockerStateSchema>;

/** Only a complete, valid dependency read can prove an issue is unblocked. */
export function classifyIssueBlockers(
  dependencies: readonly unknown[],
  truncated: boolean,
): IssueBlockerState {
  let uncertain = truncated;
  for (const dependency of dependencies) {
    if (typeof dependency !== "object" || dependency === null || !("state" in dependency)) {
      uncertain = true;
      continue;
    }
    if (dependency.state === "open") return "blocked";
    if (dependency.state !== "closed") uncertain = true;
  }
  return uncertain ? "unknown" : "unblocked";
}
