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
  if (path === "index.html") return true;
  if (/^assets\//.test(path)) {
    // Only inert raster images are permitted; SVG/HTML/JS assets can contain executable content.
    return /\.(?:png|jpe?g|webp|avif|gif)$/i.test(path);
  }
  return path.startsWith("css/") ||
    path.startsWith("js/") ||
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
  /auth(?:entication|orization)?/i,
  /jwt|access[_ -]?token|refresh[_ -]?token|session/i,
  /school[_ -]?admin|admin[_ -]?(?:panel|role|access|permission)/i,
  /(?:user|profile|account)[_. -]?(?:id|role|permission|delete|remove|block|suspend)/i,
  /(?:role|permission)[_. -]?(?:change|grant|revoke|update)/i,
  /security definer|service_role|\b(?:RLS|GRANT|REVOKE)\b/i,
  /storage[_ -]?polic(?:y|ies)|upload[_ -]?(?:permission|policy)/i,
  /api[_ -]?key|secret[_ -]?key|private[_ -]?key/i,
  /personal[_ -]?data|private[_ -]?(?:message|content|data)/i,
  /(?:messages|chat)[_. -]?(?:read|write|delete|access|permission)/i,
  /\.rpc\s*\(|auth\.users|auth\.uid\s*\(/i,
  /bulk[_ -]?(?:delete|update|migration)/i,
  /irreversible|irreversib(?:le|ility)/i,
];

function changedLinesOnly(patch) {
  return patch
    .split(/\r?\n/)
    .filter((line) => /^[+-](?![+-])/.test(line))
    .join("\n");
}

export function requiresManualApproval(summary, patch) {
  if (!summary || summary.risk !== "low" || summary.requires_approval !== false) return true;
  const codePaths = extractPatchPaths(patch).filter((path) =>
    path === "index.html" || path.startsWith("js/")
  );
  if (codePaths.length === 0) return false;
  const changedText = changedLinesOnly(patch);
  return CRITICAL_CHANGE_PATTERNS.some((pattern) => pattern.test(changedText));
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
