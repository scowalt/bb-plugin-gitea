import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  bb: { server: string; host: string; app: string };
};

function resolveImport(from: string, specifier: string): string {
  const base = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : join(dirname(from), specifier);
  const stem = base.replace(/\.js$/, "");
  const candidate = [base, `${stem}.ts`, `${stem}.tsx`, join(base, "index.ts")].find(
    (path) => existsSync(path) && !path.endsWith("/"),
  );
  if (!candidate) throw new Error(`${relative(root, from)} imports ${specifier}, which does not exist`);
  return candidate;
}

function localModules(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((entry) => join(root, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']((?:\.{1,2}|@)\/[^"']+)["']/g))
      queue.push(resolveImport(file, specifier!));
  }
  return [...seen].map((file) => relative(root, file)).sort();
}

it("publishes every local module the server, host, and app load", () => {
  const { server, host, app } = manifest.bb;
  const modules = localModules([server, host, app]);
  expect(modules).toEqual(
    expect.arrayContaining(["legacy-import", "refresher", "scanner", "service", "store"].map((name) => `thread-items/${name}.ts`)),
  );
  const published = (path: string) =>
    manifest.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
  expect(modules.filter((path) => !published(path))).toEqual([]);
});
