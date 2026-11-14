const TARGET_PATH = /(?:index\.html|(?:css|js|assets|docs|tests)\/[A-Za-z0-9._/-]+)/i;

/**
 * Detect a narrow, explicit "edit only this file" instruction.
 * This lets the agent skip a redundant planning call when the task itself
 * already identifies the writable target. Referenced test files remain context,
 * not targets.
 */
export function extractExplicitTargetPaths(task, trackedPaths, isAllowed) {
  if (typeof task !== "string" || !Array.isArray(trackedPaths) || typeof isAllowed !== "function") {
    throw new TypeError("Task, tracked paths and path validator are required.");
  }

  const patterns = [
    /(?:измени(?:ть)?|изменяй|поменяй|обнови)\s+только\s+((?:index\.html|(?:css|js|assets|docs|tests)\/[A-Za-z0-9._/-]+))/giu,
    /(?:modify|change|edit|update)\s+only\s+((?:index\.html|(?:css|js|assets|docs|tests)\/[A-Za-z0-9._/-]+))/giu,
  ];
  const requested = [];
  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) {
      const candidate = match[1].replace(/[.,;:!?]+$/u, "");
      if (TARGET_PATH.test(candidate)) requested.push(candidate);
    }
  }

  const tracked = new Set(trackedPaths);
  return [...new Set(requested)].filter((path) => tracked.has(path) && isAllowed(path)).slice(0, 4);
}

/**
 * Apply exact, unique search/replace operations to already-selected tracked
 * files. The model never writes unified-diff syntax; Git creates the patch.
 */
export function applyTextEdits(sourceByPath, edits, selectedPaths) {
  if (!(sourceByPath instanceof Map)) {
    throw new TypeError("sourceByPath must be a Map.");
  }
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 16) {
    throw new Error("The model must return between 1 and 16 edit operations.");
  }

  const selected = new Set(selectedPaths || []);
  const updated = new Map(sourceByPath);

  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error("Edit " + (index + 1) + " must be an object.");
    }

    const { path, find, replace } = edit;
    if (typeof path !== "string" || !selected.has(path) || !updated.has(path)) {
      throw new Error("Edit " + (index + 1) + " targets a file that was not selected.");
    }
    if (typeof find !== "string" || !find.trim() || find.length > 20000) {
      throw new Error("Edit " + (index + 1) + " needs a non-empty exact search fragment (max 20 KB).");
    }
    if (typeof replace !== "string" || replace.length > 60000) {
      throw new Error("Edit " + (index + 1) + " needs replacement text (max 60 KB).");
    }

    const source = updated.get(path);
    const first = source.indexOf(find);
    if (first < 0) {
      throw new Error("Exact search fragment for edit " + (index + 1) + " was not found in " + path + ".");
    }
    if (source.indexOf(find, first + find.length) >= 0) {
      throw new Error("Exact search fragment for edit " + (index + 1) + " is ambiguous in " + path + "; include more surrounding lines.");
    }
    if (find === replace) {
      throw new Error("Edit " + (index + 1) + " does not change the source.");
    }

    updated.set(path, source.slice(0, first) + replace + source.slice(first + find.length));
  }

  const changedOutputBytes = [...updated.entries()].reduce((sum, [path, source]) => {
    return source === sourceByPath.get(path) ? sum : sum + Buffer.byteLength(source);
  }, 0);
  if (changedOutputBytes > 1500000) {
    throw new Error("Changed source exceeds the 1.5 MB output limit.");
  }
  return updated;
}
