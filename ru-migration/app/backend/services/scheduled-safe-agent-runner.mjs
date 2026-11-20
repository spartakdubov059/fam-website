const SCHEDULE = Object.freeze([
  { taskType: 'system_health_check', hour: 3, minute: 40 },
  { taskType: 'daily_report_digest', hour: 4, minute: 0 },
]);

export function getDueSafeAgentTasks(value = new Date()) {
  const now = new Date(value);
  if (!Number.isFinite(now.getTime())) throw new TypeError('invalid safe agent schedule time');
  const tasks = SCHEDULE.filter(item => now.getUTCHours() === item.hour && now.getUTCMinutes() === item.minute)
    .map(item => item.taskType);
  if (now.getUTCMinutes() === 30) tasks.push('site_error_digest');
  return tasks;
}

export function createScheduledSafeAgentRunner({ queue, worker, now = () => new Date() } = {}) {
  if (typeof queue?.enqueueSafeTask !== 'function' || typeof worker !== 'function' || typeof now !== 'function') {
    throw new TypeError('safe agent queue, worker and clock are required');
  }
  return async function runScheduledSafeAgentTasks() {
    const current = new Date(now());
    const slot = current.toISOString().slice(0, 16);
    const taskTypes = getDueSafeAgentTasks(current);
    let created = 0;
    for (const taskType of taskTypes) {
      const result = await queue.enqueueSafeTask(taskType, slot);
      if (result?.created === true) created++;
    }
    const result = await worker(3);
    return Object.freeze({ ...result, scheduled: taskTypes.length, created });
  };
}
