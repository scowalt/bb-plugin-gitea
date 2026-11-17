import { expect, it } from "vitest";
import { createAncestry } from "./ancestry.js";

it("asks bb about 200 threads per list and at most four lists at once", async () => {
  const linked = Array.from({ length: 1_000 }, (_, index) => `thr-${index}`);
  const calls: number[] = [];
  let open = 0;
  let mostOpen = 0;
  const threads = {
    async list({ threadIds, archived }: { threadIds: readonly string[]; archived: boolean }) {
      calls.push(threadIds.length);
      mostOpen = Math.max(mostOpen, ++open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return archived ? [] : threadIds.map((id) => ({ id, parentThreadId: id === "thr-0" ? null : "thr-0", title: id, titleFallback: null }));
    },
  };
  const ancestry = createAncestry({ threads, log: { warn() {} }, maxDepth: 4, ttlMs: 30_000 });
  const { below } = await ancestry.of(linked);
  expect(below.get("thr-0")).toHaveLength(1_000);
  expect(calls).toEqual(Array(10).fill(200));
  expect(mostOpen).toBe(4);
});
