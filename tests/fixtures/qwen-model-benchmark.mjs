export function normalizeSearchInput(value) {
  return String(value ?? "").toLowerCase().trim();
}
