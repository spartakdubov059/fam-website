const EVIDENCE_LIMIT = 8;
const EVIDENCE_TEXT_LIMIT = 500;

export function verifyModelEvidence(entries, sourceByPath) {
  if (!Array.isArray(entries) || !sourceByPath || typeof sourceByPath !== "object") return [];

  const verified = [];
  const seen = new Set();

  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().slice(0, EVIDENCE_TEXT_LIMIT);
    const match = /^(.+):([1-9]\d*):\s*(\S.*)$/.exec(value);
    if (!match) continue;

    const [, path, lineNumberText, quotedLine] = match;
    const source = sourceByPath[path];
    if (typeof source !== "string") continue;

    const lineNumber = Number(lineNumberText);
    const sourceLine = source.split(/\r?\n/)[lineNumber - 1];
    if (typeof sourceLine !== "string" || sourceLine.trim() !== quotedLine.trim()) continue;

    const canonical = path + ":" + lineNumber + ": " + sourceLine.trim();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    verified.push(canonical);
    if (verified.length >= EVIDENCE_LIMIT) break;
  }

  return verified;
}
