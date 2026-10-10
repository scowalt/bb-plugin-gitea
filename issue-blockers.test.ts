import { expect, it } from "vitest";
import { classifyIssueBlockers } from "./issue-blockers";

it.each([
  { dependencies: [], truncated: false, expected: "unblocked" },
  { dependencies: [{ state: "closed" }], truncated: false, expected: "unblocked" },
  { dependencies: [{ state: "open" }], truncated: false, expected: "blocked" },
  { dependencies: [{ state: "closed" }, { state: "open" }], truncated: false, expected: "blocked" },
  { dependencies: [{ state: "closed" }], truncated: true, expected: "unknown" },
  { dependencies: [null, {}, { state: "unexpected" }], truncated: false, expected: "unknown" },
  { dependencies: [{ state: "OPEN" }], truncated: false, expected: "unknown" },
  { dependencies: [null, { state: "open" }], truncated: true, expected: "blocked" },
])("classifies dependencies without guessing ($expected, truncated: $truncated)", ({ dependencies, truncated, expected }) => {
  expect(classifyIssueBlockers(dependencies, truncated)).toBe(expected);
});
