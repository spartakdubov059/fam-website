export async function finishTaskAndCount(rpc, {
  taskId,
  workerId,
  status,
  summary,
}) {
  const saved = await rpc("finish_fam_agent_task", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_status: status,
    p_summary: summary,
  });

  if (saved !== true) {
    throw new Error("task_finish_not_saved");
  }

  return status === "completed" ? "completed" : "blocked";
}
