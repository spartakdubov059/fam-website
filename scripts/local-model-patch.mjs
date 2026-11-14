export function normalizeUnifiedDiffHunkCounts(patch) {
  if (typeof patch !== "string" || !patch.trim()) {
    throw new TypeError("Patch must be a non-empty string.");
  }

  const normalized = patch.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(hunkPattern);
    if (!match) continue;

    let oldCount = 0;
    let newCount = 0;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];

      if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
      if (line === "" && hasTrailingNewline && cursor === lines.length - 1) continue;

      if (line.startsWith(" ")) {
        oldCount += 1;
        newCount += 1;
      } else if (line.startsWith("-")) {
        oldCount += 1;
      } else if (line.startsWith("+")) {
        newCount += 1;
      } else if (line.startsWith("\\")) {
        // Git's "\ No newline at end of file" marker is not part of either hunk count.
      } else {
        throw new Error("Unrecognized unified diff hunk line at line " + (cursor + 1) + ".");
      }
    }

    const oldStart = match[1];
    const newStart = match[3];
    const suffix = match[5];
    lines[index] = "@@ -" + oldStart + "," + oldCount +
      " +" + newStart + "," + newCount + " @@" + suffix;
  }

  return lines.join("\n");
}

export function frameSingleFileHunkDiff(patch, path) {
  if (typeof patch !== "string" || typeof path !== "string") {
    throw new TypeError("Patch and path must be strings.");
  }

  const normalized = patch.replace(/\r\n?/g, "\n").trim();
  if (!/^(?:index\.html|(?:css|js|assets|docs|tests)\/[A-Za-z0-9._/-]+)$/.test(path) ||
      path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("Cannot frame a patch for a disallowed path.");
  }

  let body = normalized;
  if (normalized.startsWith("--- ")) {
    const lines = normalized.split("\n");
    if (lines[0] !== `--- a/${path}` || lines[1] !== `+++ b/${path}` || !lines[2]?.startsWith("@@ ")) {
      throw new Error("File-labelled patch must name only the selected path and contain a unified diff hunk.");
    }
    if (lines.slice(2).some((line) => /^(?:--- [ab]\/|\+\+\+ [ab]\/)/.test(line))) {
      throw new Error("File-labelled patch contains additional file headers.");
    }
    body = lines.slice(2).join("\n");
  } else if (!normalized.startsWith("@@ ")) {
    throw new Error("Unframed patch must start with a unified diff hunk or selected-file headers.");
  }

  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    body,
  ].join("\n");
}
