const SCHEDULE = Object.freeze([
  { taskType: 'system_health_check', hour: 3, minute: 40 },
  { taskType: 'daily_report_digest', hour: 4, minute: 0 },
]);

export function getDueSafeAgentTasks(value = new Date()) {
  const now = new Date(value);
  if (!Number.isFinite(now.getTime())) throw new TypeError('invalid safe agent schedule time');
  const tasks = SCHEDULE.filter(item => now.getUTCHours() === item.hour && now.getUTCMinutes() === item.minute)
    .map(item => item.taskType);
  if ([0, 15, 30, 45].includes(now.getUTCMinutes())) tasks.push('site_error_digest');
  return tasks;
}

export function createScheduledCoderTaskProducer({ repository, now = () => new Date() } = {}) {
  if (typeof repository?.enqueueSafeCoderTask !== 'function' || typeof now !== 'function') {
    throw new TypeError('coder producer dependencies are required');
  }
  return async function enqueueSafeCoderTask() {
    const current = new Date(now());
    if (!Number.isFinite(current.getTime())) throw new TypeError('invalid coder producer time');
    // This task is intentionally outside the worker allowlist. The existing worker
    // will close it as blocked without invoking a model or tool. The YDB producer
    // applies the source threshold and category allowlist in one repository query.
    current.setUTCMinutes(Math.floor(current.getUTCMinutes() / 15) * 15, 0, 0);
    const result = await repository.enqueueSafeCoderTask(current.toISOString().slice(0, 16));
    return Object.freeze({ created: result?.created === true, reason: result?.created ? 'queued_for_manual_review' : 'already_active', content_read: false });
  };
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
