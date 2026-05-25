import simpleGit, { SimpleGit } from "simple-git";
import * as path from "path";

export interface FilePatch {
  file: string;
  patch: string;
  oldContent: string;
  newContent: string;
  added: number;
  removed: number;
}

export async function getChangedFiles(
  repoPath: string,
  fromRef: string,
  toRef: string
): Promise<FilePatch[]> {
  const git: SimpleGit = simpleGit(repoPath);

  const diff = await git.diff([
    fromRef,
    toRef,
    "--name-only",
    "--diff-filter=ACMR",
  ]);

  const changedFiles = diff
    .trim()
    .split("\n")
    .filter((f) => f && (
      f.endsWith(".ts") || f.endsWith(".tsx") ||
      f.endsWith(".js") || f.endsWith(".jsx") ||
      f.endsWith(".py")
    ));

  const results: FilePatch[] = [];

  for (const file of changedFiles) {
    try {
      const [oldContent, newContent, patch, stat] = await Promise.all([
        git.show([`${fromRef}:${file}`]).catch(() => ""),
        git.show([`${toRef}:${file}`]).catch(() => ""),
        git.diff([fromRef, toRef, "--", file]),
        git.diff([fromRef, toRef, "--numstat", "--", file]),
      ]);

      const statParts = stat.trim().split("\t");
      const added = parseInt(statParts[0] || "0", 10);
      const removed = parseInt(statParts[1] || "0", 10);

      results.push({
        file,
        patch,
        oldContent,
        newContent,
        added: isNaN(added) ? 0 : added,
        removed: isNaN(removed) ? 0 : removed,
      });
    } catch {
      // skip files that can't be read (binary, deleted, etc.)
    }
  }

  return results;
}

export async function resolveRefs(
  repoPath: string,
  fromRef: string,
  toRef: string
): Promise<{ from: string; to: string }> {
  const git: SimpleGit = simpleGit(repoPath);
  const [from, to] = await Promise.all([
    git.revparse([fromRef]),
    git.revparse([toRef]),
  ]);
  return { from: from.trim(), to: to.trim() };
}

export async function getRepoRoot(cwd: string): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  const root = await git.revparse(["--show-toplevel"]);
  return root.trim();
}
