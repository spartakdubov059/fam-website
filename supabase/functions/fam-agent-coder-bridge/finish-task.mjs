export function requireSavedTaskResult(saved) {
  if (saved !== true) throw new Error("task_finish_not_saved");
  return { ok: true, saved: true };
}

export function requireSavedReport(saved, reportDate) {
  if (!saved || typeof saved !== "object" || saved.ok !== true || saved.report_date !== reportDate) {
    throw new Error("report_save_not_saved");
  }
  return { ok: true, saved: true };
}
