/**
 * Split flagged moderation categories by the input types reported by the API.
 * Unknown categories remain unresolved so an attached image is held conservatively.
 */
const TEXT_ONLY_CATEGORIES = new Set([
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "sexual/minors",
]);

export function splitFlaggedCategoriesByInputType(flaggedCategories, appliedInputTypes) {
  const result = { text: [], image: [], unresolved: [] };

  for (const category of flaggedCategories) {
    const applied = appliedInputTypes?.[category];

    if (Array.isArray(applied)) {
      if (applied.includes("text")) result.text.push(category);
      if (applied.includes("image")) result.image.push(category);
      if (!applied.includes("text") && !applied.includes("image")) {
        result.unresolved.push(category);
      }
      continue;
    }

    // Documented text-only categories can safely use the text contextual review
    // when older or partial provider responses omit this optional detail.
    if (TEXT_ONLY_CATEGORIES.has(category)) result.text.push(category);
    else result.unresolved.push(category);
  }

  return result;
}
