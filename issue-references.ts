type IssueReference = { repo: string; number: number; url: string };

/** Issue mentions are text references, not Gitea dependency records. */
export function issueReferences(
  issueUrl: string,
  repo: string,
  number: number,
  texts: string[],
): IssueReference[] {
  const found = new Map<string, IssueReference>();
  let base: URL;
  try { base = new URL(issueUrl); } catch { return []; }
  const suffix = `/${repo}/issues/${number}`;
  if (!base.pathname.endsWith(suffix)) return [];
  const prefix = base.pathname.slice(0, -suffix.length);
  for (const text of texts) {
    // Match full issue URLs, owner/repo#N and same-repository #N.
    const pattern = /https?:\/\/[^\s<>()[\]]+\/issues\/[1-9]\d*|(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*\b/g;
    for (const match of text.matchAll(pattern)) {
      const token = match[0].replace(/[.,;:!?]+$/, "");
      let targetRepo = repo;
      let targetNumber: number;
      if (token.startsWith("http")) {
        let url: URL;
        try { url = new URL(token); } catch { continue; }
        if (url.origin !== base.origin || url.search || url.hash) continue;
        if (!url.pathname.startsWith(`${prefix}/`)) continue;
        const parts = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(url.pathname.slice(prefix.length));
        if (!parts) continue;
        targetRepo = `${parts[1]}/${parts[2]}`;
        targetNumber = Number(parts[3]);
      } else {
        const [name, index] = token.split("#");
        targetRepo = name || repo;
        targetNumber = Number(index);
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo) || !Number.isSafeInteger(targetNumber) || targetNumber < 1 || (targetRepo === repo && targetNumber === number)) continue;
      const url = new URL(`${prefix}/${targetRepo.split("/").map(encodeURIComponent).join("/")}/issues/${targetNumber}`, base).href;
      found.set(`${targetRepo.toLowerCase()}#${targetNumber}`, { repo: targetRepo, number: targetNumber, url });
    }
  }
  return [...found.values()].slice(0, 100);
}
