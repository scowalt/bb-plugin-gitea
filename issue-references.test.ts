import { expect, it } from "vitest";
import { issueReferences } from "./issue-references";

it("extracts same-repo, cross-repo and same-instance URL issue references without duplicates or self links", () => {
  const refs = issueReferences("https://gitea.example/prefix/acme/widgets/issues/4", "acme/widgets", 4, [
    "See #5 and ops/api#7; #4 is this issue. https://gitea.example/prefix/ops/api/issues/7",
    "#5 https://elsewhere.example/prefix/acme/widgets/issues/8",
  ]);
  expect(refs).toEqual([
    { repo: "acme/widgets", number: 5, url: "https://gitea.example/prefix/acme/widgets/issues/5" },
    { repo: "ops/api", number: 7, url: "https://gitea.example/prefix/ops/api/issues/7" },
  ]);
});

it("does not fabricate links without a trustworthy issue URL", () => {
  expect(issueReferences("", "acme/widgets", 4, ["#5"])).toEqual([]);
});
