// Read-only reconciliation of exact PR, owner-review and CI evidence.
// This module never writes Supabase or GitHub and never grants approval.
const CODER_JOB = "Локальная модель готовит исправление";
const QA_JOB = "Независимая проверка без модели и секретов";
const MODEL_STEP = "Запустить локальную модель и подготовить patch";
const SHA = /^[0-9a-f]{40}$/i;

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" ? Date.parse(value) : NaN;
const success = (job) => job?.status === "completed" && job.conclusion === "success";

function trustedPR(pr, branch, repository) {
  return validId(pr?.number) &&
    pr.user?.login === "github-actions[bot]" &&
    pr.base?.ref === "main" &&
    pr.base?.repo?.full_name === repository &&
    pr.head?.ref === branch &&
    pr.head?.repo?.full_name === repository &&
    SHA.test(pr.head?.sha || "");
}

export function ownerApproval(reviews, owner, head, mergedAt = null, createdAt = null, reopenedAt = null) {
  if (!Array.isArray(reviews) || !SHA.test(head || "")) return false;
  const cutoff = mergedAt === null ? Infinity : timestamp(mergedAt);
  const createdLower = createdAt === null ? -Infinity : timestamp(createdAt);
  const reopenLower = reopenedAt === null ? -Infinity : timestamp(reopenedAt);
  const lower = Math.max(createdLower, reopenLower);
  if (Number.isNaN(cutoff) || Number.isNaN(lower) || lower > cutoff) return false;
  const relevant = reviews.filter((review) =>
    review?.user?.login === owner &&
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state) &&
    Number.isFinite(timestamp(review.submitted_at)) &&
    (reopenedAt === null
      ? timestamp(review.submitted_at) >= lower
      : timestamp(review.submitted_at) > lower) &&
    timestamp(review.submitted_at) <= cutoff
  ).sort((a, b) =>
    timestamp(b.submitted_at) - timestamp(a.submitted_at) ||
    (Number(b.id) || 0) - (Number(a.id) || 0)
  );
  return relevant[0]?.state === "APPROVED" && relevant[0].commit_id === head;
}

async function latestReopenedAt(read, prNumber, mergedAt) {
  const upper = mergedAt === null ? Infinity : timestamp(mergedAt);
  if (Number.isNaN(upper)) throw new Error("Invalid merge timestamp for PR timeline");
  const transitions = [];
  for (let page = 1; page <= 10; page++) {
    const events = await read("/issues/" + prNumber + "/timeline?per_page=100&page=" + page);
    if (!Array.isArray(events) || events.length > 100) throw new Error("Invalid PR timeline response");
    for (const event of events) {
      if (event?.event !== "reopened") continue;
      const at = timestamp(event.created_at);
      if (!Number.isFinite(at)) throw new Error("Incomplete PR reopen event");
      if (at <= upper) transitions.push(at);
    }
    if (events.length < 100) return transitions.length ? Math.max(...transitions) : null;
  }
  throw new Error("PR timeline exceeds the reconciliation limit");
}

function exactCI(runs, sha, branch, event, notBefore, notAfter = null) {
  if (!Array.isArray(runs) || !SHA.test(sha || "") || !Number.isFinite(timestamp(notBefore))) {
    return "unconfirmed";
  }
  const upper = notAfter === null ? Infinity : timestamp(notAfter);
  if (Number.isNaN(upper) || upper < timestamp(notBefore)) return "unconfirmed";
  const matches = runs.filter((run) =>
    validId(run?.id) &&
    run.head_sha === sha &&
    run.event === event &&
    run.head_branch === branch &&
    Number.isFinite(timestamp(run.created_at)) &&
    timestamp(run.created_at) >= timestamp(notBefore) &&
    timestamp(run.created_at) <= upper
  ).sort((a, b) =>
    timestamp(b.created_at) - timestamp(a.created_at) || b.id - a.id
  );
  const latest = matches[0];
  if (!latest) return "unconfirmed";
  if (latest.status !== "completed") return "pending";
  if (notAfter !== null &&
      (!Number.isFinite(timestamp(latest.updated_at)) ||
       timestamp(latest.updated_at) < timestamp(latest.created_at) ||
       timestamp(latest.updated_at) > upper)) return "unconfirmed";
  return latest.conclusion === "success" ? "verified" :
    latest.conclusion === "failure" ? "failed" : "unconfirmed";
}

export function exactPostMergeCI(runs, sha, mergedAt) {
  return exactCI(runs, sha, "main", "push", mergedAt);
}

export function exactBranchCI(runs, sha, runId, prCreatedAt, mergedAt = null) {
  if (!validId(runId)) return "unconfirmed";
  return exactCI(runs, sha, "codex/fam-run-" + runId,
    "workflow_dispatch", prCreatedAt, mergedAt);
}

export async function collectCoderLifecycle({ runs = [], repository, read, limit = 10 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
      typeof read !== "function") throw new Error("Invalid lifecycle evidence source");
  const owner = repository.split("/")[0];
  const maximum = Math.min(10, Math.max(0, Number.isSafeInteger(limit) ? limit : 10));
  const candidates = [...new Map(runs.filter((run) => {
    if (!validId(run?.id) || run.head_branch !== "main" || !Array.isArray(run.jobs)) return false;
    const generate = run.jobs.find((job) => job.name === CODER_JOB);
    const qa = run.jobs.find((job) => job.name === QA_JOB);
    return success(generate) && success(qa) &&
      generate.steps?.some((step) => step.name === MODEL_STEP && step.conclusion === "success");
  }).map((run) => [run.id, run])).values()]
    .sort((a, b) => b.id - a.id);

  const rows = [];
  for (const run of candidates.slice(0, maximum)) {
    const row = {
      run_id: run.id, pr_number: null, pr_created: false,
      owner_approved: false, merged: false, pr_state: "unconfirmed",
      draft: null, head_sha: null, merge_commit_sha: null,
      branch_ci: "unconfirmed", postmerge: "unconfirmed", evidence: "unavailable",
      reopened_at: null, review_history_complete: false, persistence: { status: "not_attempted" },
    };
    rows.push(row);
    const branch = "codex/fam-run-" + run.id;
    try {
      const prs = await read("/pulls?state=all&base=main&head=" +
        encodeURIComponent(owner + ":" + branch) + "&per_page=10");
      if (!Array.isArray(prs) || prs.length >= 10) continue;
      const matching = prs.filter((pr) => trustedPR(pr, branch, repository));
      if (matching.length !== 1) {
        row.evidence = matching.length ? "ambiguous" : "no_pr";
        continue;
      }
      const pr = await read("/pulls/" + matching[0].number);
      if (!trustedPR(pr, branch, repository) || pr.number !== matching[0].number) continue;
      if (!Number.isFinite(timestamp(pr.created_at))) continue;
      if (Number.isFinite(timestamp(run.created_at)) &&
          timestamp(pr.created_at) < timestamp(run.created_at)) continue;
      row.pr_number = pr.number;
      row.head_sha = pr.head.sha;
      row.draft = typeof pr.draft === "boolean" ? pr.draft : null;
      if (typeof pr.body === "string") {
        const taskMatch = pr.body.match(/FAM task ID: `([0-9a-f-]{36})`/i);
        if (taskMatch && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskMatch[1])) {
          row.task_id = taskMatch[1];
        }
      }
      row.pr_created = true;
      row.evidence = "pr_confirmed";
      row.merged = pr.merged === true && pr.state === "closed" &&
        Number.isFinite(timestamp(pr.merged_at)) &&
        timestamp(pr.merged_at) >= timestamp(pr.created_at) &&
        SHA.test(pr.merge_commit_sha || "");
      if (row.merged) {
        row.pr_state = "merged";
        row.merge_commit_sha = pr.merge_commit_sha;
      } else if (pr.merged === false && pr.state === "closed") {
        row.pr_state = "closed_unmerged";
      } else if (pr.merged === false && pr.state === "open") {
        row.pr_state = "open";
      }
      try {
        row.reopened_at = await latestReopenedAt(read, pr.number, row.merged ? pr.merged_at : null);
        row.review_history_complete = true;
      } catch {
        row.review_history_complete = false;
      }
      try {
        const reviews = await read("/pulls/" + pr.number + "/reviews?per_page=100");
        if (Array.isArray(reviews) && reviews.length < 100 && row.review_history_complete) {
          row.owner_approved = ownerApproval(reviews, owner, pr.head.sha,
            row.merged ? pr.merged_at : null, pr.created_at, row.reopened_at);
          row.evidence = "review_checked";
        }
      } catch { /* approval remains unconfirmed */ }
      try {
        const branchRuns = await read("/actions/workflows/moderation-regression.yml/runs?branch=" +
          encodeURIComponent(branch) + "&event=workflow_dispatch&head_sha=" + pr.head.sha + "&per_page=20");
        if (Array.isArray(branchRuns?.workflow_runs) && branchRuns.workflow_runs.length < 20) {
          row.branch_ci = exactBranchCI(branchRuns.workflow_runs, pr.head.sha,
            run.id, pr.created_at, row.merged ? pr.merged_at : null);
        }
      } catch { /* branch CI remains unconfirmed */ }
      if (row.merged) {
        try {
          const postmergeRuns = await read("/actions/workflows/moderation-regression.yml/runs?branch=main&event=push&head_sha=" +
            pr.merge_commit_sha + "&per_page=20");
          if (Array.isArray(postmergeRuns?.workflow_runs) && postmergeRuns.workflow_runs.length < 20) {
            row.postmerge = exactPostMergeCI(postmergeRuns.workflow_runs,
              pr.merge_commit_sha, pr.merged_at);
          }
        } catch { /* postmerge CI remains unconfirmed */ }
      }
    } catch { /* preserve only independently confirmed stages */ }
  }
  return { rows, limited: candidates.length > maximum };
}

export function classifyReviewState(row) {
  if (!row?.pr_created) return "unconfirmed";
  if (row.pr_state === "closed_unmerged" && !row.merged) return "closed_unmerged";
  if (row.pr_state === "open" && !row.merged) {
    if (row.draft !== false) return row.draft === true ? "draft_waiting_review" : "waiting_review_or_ci";
    return row.owner_approved && row.branch_ci === "verified"
      ? "approved_waiting_merge" : "waiting_review_or_ci";
  }
  if (row.pr_state === "merged" && row.merged) {
    if (row.draft !== false || !row.owner_approved || row.branch_ci !== "verified") {
      return "merged_evidence_incomplete";
    }
    if (row.postmerge === "verified") return "merge_ci_verified";
    if (row.postmerge === "failed") return "postmerge_failed";
    return "postmerge_unconfirmed";
  }
  return "unconfirmed";
}

export function lifecycleStagesForRow(row) {
  const state = classifyReviewState(row);
  const base = {
    task_id: row?.task_id,
    pr_number: row?.pr_number,
    head_sha: row?.head_sha,
  };
  if (!base.task_id || !validId(base.pr_number) || !SHA.test(base.head_sha || "")) return [];
  if (state === "closed_unmerged") return [{ ...base, stage: "pr_closed_unmerged" }];
  if (state === "approved_waiting_merge") return [{ ...base, stage: "owner_approved" }];
  if (state === "merge_ci_verified" || state === "postmerge_failed" ||
      state === "postmerge_unconfirmed") {
    if (!SHA.test(row.merge_commit_sha || "")) return [];
    const stages = [
      { ...base, stage: "owner_approved" },
      { ...base, stage: "merged", merge_commit_sha: row.merge_commit_sha },
    ];
    if (state === "merge_ci_verified") {
      stages.push({ ...base, stage: "postmerge_verified", merge_commit_sha: row.merge_commit_sha });
    } else if (state === "postmerge_failed") {
      stages.push({ ...base, stage: "postmerge_failed", merge_commit_sha: row.merge_commit_sha });
    }
    return stages;
  }
  return [];
}

export async function persistLifecycleRows(rows, persist) {
  if (typeof persist !== "function") throw new Error("Lifecycle persistence adapter is required");
  for (const row of rows) {
    const stages = lifecycleStagesForRow(row);
    if (!stages.length) continue;
    row.persistence = { status: "saved", stages: [] };
    for (const stage of stages) {
      try {
        const result = await persist(stage);
        if (result?.ok !== true || result?.resolved !== true) {
          row.persistence = {
            status: "rejected", stage: stage.stage, stages: [...row.persistence.stages],
          };
          break;
        }
        row.persistence.stages.push(stage.stage);
      } catch {
        row.persistence = {
          status: "failed", stage: stage.stage, stages: [...row.persistence.stages],
        };
        break;
      }
    }
  }
  return rows;
}

export function formatCoderLifecycle({ rows = [], limited = false } = {}) {
  const lines = ["## INTEGRATOR — подтверждённые стадии Qwen после QA"];
  if (!rows.length) lines.push("Нет запусков с подтверждённой генерацией и QA в проверенной выборке.");
  for (const row of rows) {
    const ciLabel = {
      verified: "успешен", failed: "ошибка",
      pending: "ожидается", unconfirmed: "не подтверждён",
    };
    const stateLabel = {
      unconfirmed: "не подтверждён",
      closed_unmerged: "закрыт без merge",
      draft_waiting_review: "черновик; не готов к merge",
      approved_waiting_merge: "одобрение точной ревизии подтверждено",
      waiting_review_or_ci: "ожидает review или CI",
      merged_evidence_incomplete: "merge есть, одобрение или CI неполны",
      merge_ci_verified: "merge и CI объединённого коммита подтверждены",
      postmerge_failed: "CI объединённого коммита не прошёл",
      postmerge_unconfirmed: "CI объединённого коммита не подтверждён",
    };
    lines.push("- Run " + row.run_id + ": " +
      (row.pr_created ? "PR #" + row.pr_number : "PR не подтверждён") +
      "; CI ревизии PR: " + (ciLabel[row.branch_ci] || "не подтверждён") +
      "; одобрение владельца точной ревизии: " + (row.owner_approved ? "подтверждено" : "не подтверждено") +
      "; merge: " + (row.merged ? "подтверждён" : "не подтверждён") +
      "; CI объединённого коммита: " + (ciLabel[row.postmerge] || "не подтверждён") +
      "; состояние: " + (stateLabel[classifyReviewState(row)] || "не подтверждён") + ".");
    const persistenceLabel = {
      saved: "сохранено",
      rejected: "Supabase отклонил переход",
      failed: "ошибка сохранения",
      not_attempted: "не требовалось",
      not_configured: "токен INTEGRATOR не настроен",
    }[row.persistence?.status] || "не подтверждено";
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) +
      "; запись lifecycle: " + persistenceLabel +
      (row.persistence?.stage ? " (" + row.persistence.stage + ")" : "") + ".";
  }
  if (limited) lines.push("Достигнут лимит выборки; отчёт неполный.");
  lines.push("Это read-only сверка метаданных GitHub. Не подтверждённое одобрение не считается разрешением.");
  return lines.join("\n");
}
