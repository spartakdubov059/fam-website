import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findOpenTaskPr(pullRequests, taskId) {
  if (!Array.isArray(pullRequests) || typeof taskId !== "string" || taskId.length < 1 || taskId.length > 128) {
    throw new Error("Invalid task PR lookup input");
  }
  const marker = `- FAM task ID: \`${taskId}\``;
  const matches = pullRequests.filter((pullRequest) =>
    Number.isSafeInteger(pullRequest?.number) &&
    pullRequest.number > 0 &&
    typeof pullRequest.url === "string" &&
    typeof pullRequest.body === "string" &&
    pullRequest.body.split(/\r?\n/).some((line) => line.trim() === marker),
  );
  if (matches.length > 1) throw new Error("Multiple open PRs match the FAM task");
  return matches[0] ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const taskId = process.argv[2];
    const pullRequests = JSON.parse(readFileSync(0, "utf8"));
    const match = findOpenTaskPr(pullRequests, taskId);
    if (match) process.stdout.write(`${match.number}\t${match.url}\n`);
  } catch {
    process.stderr.write("Unable to safely reconcile an existing FAM task PR.\n");
    process.exitCode = 1;
  }
}
