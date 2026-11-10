import { readFileSync } from "node:fs";

export function extractPatchPaths(patch) {
  const paths = [];
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)\s*$/gm)) {
    if (match[1] !== match[2]) {
      throw new Error("Rename patches are not accepted by the FAM agent.");
    }
    paths.push(match[1]);
  }
  if (paths.length === 0) throw new Error("Patch contains no git diff file headers.");
  return [...new Set(paths)];
}

export function isAllowedAgentPath(path) {
  if (path.startsWith("/") || path.split("/").includes("..")) return false;
  return path === "index.html" ||
    path.startsWith("css/") ||
    path.startsWith("js/") ||
    path.startsWith("assets/") ||
    path.startsWith("docs/") ||
    path.startsWith("tests/");
}

const CRITICAL_CHANGE_PATTERNS = [
  /account[_ -]?deletion/i,
  /delete[_ -]?(account|user|profile)/i,
  /(?:remove|erase)[_ -]?(?:account|user|personal data)/i,
  /suspend(?:ed|ing)?[_ -]?(?:account|user)/i,
  /ban(?:ned|ning)?[_ -]?(?:account|user)/i,
  /moderation[_ -]?(?:decision|action|policy)/i,
  /auth\.users|service_role|security definer/i,
  /\b(?:RLS|GRANT|REVOKE)\b/,
  /storage[_ -]?polic(?:y|ies)/i,
  /api[_ -]?key|secret[_ -]?key|access[_ -]?token/i,
  /role[_ -]?(?:change|grant|permission)|permission[_ -]?change/i,
  /bulk[_ -]?(?:delete|update|migration)/i,
];

export function requiresManualApproval(summary, patch) {
  if (!summary || summary.risk !== "low" || summary.requires_approval !== false) return true;
  return CRITICAL_CHANGE_PATTERNS.some((pattern) => pattern.test(patch));
}

export function validateAgentPatch(patch, summary) {
  const paths = extractPatchPaths(patch);
  const rejected = paths.filter((path) => !isAllowedAgentPath(path));
  if (rejected.length) {
    throw new Error("Patch contains paths outside the FAM agent allowlist: " + rejected.join(", "));
  }
  return {
    paths,
    requires_approval: requiresManualApproval(summary, patch),
  };
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [patchPath, summaryPath] = process.argv.slice(2);
  if (!patchPath || !summaryPath) {
    throw new Error("Usage: node scripts/validate-local-agent-patch.mjs <patch> <summary.json>");
  }
  const patch = readFileSync(patchPath, "utf8");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const result = validateAgentPatch(patch, summary);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      "requires_approval=" + String(result.requires_approval) + "\n" +
      "changed_paths=" + result.paths.join(",") + "\n",
    );
  }
}
