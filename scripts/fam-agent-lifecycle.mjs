// Read-only reconciliation of Qwen runs, bot PRs, owner reviews and exact-commit CI.
// GitHub evidence is kept separate from the Supabase queue; no lifecycle writes.
const CODER_JOB = "Локальная модель готовит исправление";
const QA_JOB = "Независимая проверка без модели и секретов";
const MODEL_STEP = "Запустить локальную модель и подготовить patch";
const SHA = /^[0-9a-f]{40}$/i;
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const timestamp = (s) => typeof s === "string" ? Date.parse(s) : NaN;
const success = (job) => job?.status === "completed" && job.conclusion === "success";

function trustedPR(pr, branch, repository) {
  return validId(pr?.number) &&
    pr.user?.login === "github-actions[bot]" &&
    pr.base?.ref === "main" && pr.base?.repo?.full_name === repository &&
    pr.head?.ref === branch && pr.head?.repo?.full_name === repository &&
    SHA.test(pr.head?.sha || "");
}

export function ownerApproval(reviews, owner, head, mergedAt = null, createdAt = null) {
  if (!Array.isArray(reviews) || !SHA.test(head || "")) return false;
  const cutoff = mergedAt === null ? Infinity : timestamp(mergedAt);
  const lower = createdAt === null ? -Infinity : timestamp(createdAt);
  if (Number.isNaN(cutoff) || Number.isNaN(lower) || lower > cutoff) return false;
  const relevant = reviews.filter((r) => r?.user?.login === owner &&
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) &&
    Number.isFinite(timestamp(r.submitted_at)) && timestamp(r.submitted_at) >= lower &&
    timestamp(r.submitted_at) <= cutoff)
    .sort((a, b) => timestamp(b.submitted_at) - timestamp(a.submitted_at) ||
      (Number(b.id) || 0) - (Number(a.id) || 0));
  return relevant[0]?.state === "APPROVED" && relevant[0].commit_id === head;
}

function exactCI(runs, sha, branch, event, notBefore, notAfter = null) {
  if (!Array.isArray(runs) || !SHA.test(sha || "") || !Number.isFinite(timestamp(notBefore))) return "unconfirmed";
  const upper = notAfter === null ? Infinity : timestamp(notAfter);
  if (Number.isNaN(upper) || upper < timestamp(notBefore)) return "unconfirmed";
  const matches = runs.filter((r) => validId(r?.id) && r.head_sha === sha &&
    r.event === event && r.head_branch === branch &&
    Number.isFinite(timestamp(r.created_at)) && timestamp(r.created_at) >= timestamp(notBefore) &&
    timestamp(r.created_at) <= upper)
    .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || b.id - a.id);
  const latest = matches[0];
  if (!latest) return "unconfirmed";
  if (latest.status !== "completed") return "pending";
  // For a historical merge, a success observed only after the merge cannot
  // establish that the branch passed CI before the owner's decision.
  if (notAfter !== null && (!Number.isFinite(timestamp(latest.updated_at)) ||
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
  return exactCI(runs, sha, "codex/fam-run-" + runId, "workflow_dispatch", prCreatedAt, mergedAt);
}

export async function collectCoderLifecycle({ runs = [], repository, read, limit = 10 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
      typeof read !== "function") throw new Error("Invalid lifecycle evidence source");
  const owner = repository.split("/")[0];
  const maximum = Math.min(10, Math.max(0, Number.isSafeInteger(limit) ? limit : 10));
  const candidates = [...new Map(runs.filter((run) => {
    if (!validId(run?.id) || run.head_branch !== "main" || !Array.isArray(run.jobs)) return false;
    const gen = run.jobs.find((j) => j.name === CODER_JOB);
    const qa = run.jobs.find((j) => j.name === QA_JOB);
    return success(gen) && success(qa) &&
      gen.steps?.some((s) => s.name === MODEL_STEP && s.conclusion === "success");
  }).map((r) => [r.id, r])).values()].sort((a,b) => b.id - a.id);
  const rows = [];
  for (const run of candidates.slice(0, maximum)) {
    const row = { run_id: run.id, pr_number: null, pr_created: false,
      owner_approved: false, merged: false, pr_state: "unconfirmed", draft: null, branch_ci: "unconfirmed", postmerge: "unconfirmed", evidence: "unavailable" };
    rows.push(row);
    const branch = "codex/fam-run-" + run.id;
    try {
      const prs = await read("/pulls?state=all&base=main&head=" +
        encodeURIComponent(owner + ":" + branch) + "&per_page=10");
      if (!Array.isArray(prs) || prs.length >= 10) continue;
      const matching = prs.filter((pr) => trustedPR(pr, branch, repository));
      if (matching.length !== 1) { row.evidence = matching.length ? "ambiguous" : "no_pr"; continue; }
      const pr = await read("/pulls/" + matching[0].number);
      if (!trustedPR(pr, branch, repository) || pr.number !== matching[0].number) continue;
      if (!Number.isFinite(timestamp(pr.created_at))) continue;
      // A known workflow start bounds PR creation. Do not accept a PR which
      // predates its supposed originating run.
      if (Number.isFinite(timestamp(run.created_at)) && timestamp(pr.created_at) < timestamp(run.created_at)) continue;
      row.pr_number = pr.number;
      row.draft = typeof pr.draft === "boolean" ? pr.draft : null;
      row.pr_created = true;
      row.evidence = "pr_confirmed";
      row.merged = pr.merged === true && pr.state === "closed" &&
        Number.isFinite(timestamp(pr.merged_at)) && timestamp(pr.merged_at) >= timestamp(pr.created_at) &&
        SHA.test(pr.merge_commit_sha || "");
      // A closed but unmerged PR is not a completed task. Incomplete or
      // contradictory metadata never proves an owner decision.
      if (row.merged && pr.state === "closed") row.pr_state = "merged";
      else if (pr.merged === false && pr.state === "closed") row.pr_state = "closed_unmerged";
      else if (pr.merged === false && pr.state === "open") row.pr_state = "open";
      // Independent reads: a missing review response must not conceal
      // a separately verified regression run, and vice versa.
      try {
        const reviews = await read("/pulls/" + pr.number + "/reviews?per_page=100");
        if (Array.isArray(reviews) && reviews.length < 100) {
          row.owner_approved = ownerApproval(reviews, owner, pr.head.sha, row.merged ? pr.merged_at : null, pr.created_at);
          row.evidence = "review_checked";
        }
      } catch { /* approval remains unconfirmed */ }
      if (Number.isFinite(timestamp(pr.created_at))) {
        try {
          const result = await read("/actions/workflows/moderation-regression.yml/runs?branch=" +
            encodeURIComponent(branch) + "&event=workflow_dispatch&head_sha=" + pr.head.sha + "&per_page=20");
          if (Array.isArray(result?.workflow_runs) && result.workflow_runs.length < 20)
            row.branch_ci = exactBranchCI(result.workflow_runs, pr.head.sha, run.id, pr.created_at, row.merged ? pr.merged_at : null);
        } catch { /* branch CI remains unconfirmed */ }
      }
      if (row.merged) {
        try {
          const result = await read("/actions/workflows/moderation-regression.yml/runs?branch=main&event=push&head_sha=" +
            pr.merge_commit_sha + "&per_page=20");
          if (Array.isArray(result?.workflow_runs) && result.workflow_runs.length < 20)
            row.postmerge = exactPostMergeCI(result.workflow_runs, pr.merge_commit_sha, pr.merged_at);
        } catch { /* postmerge CI remains unconfirmed */ }
      }
    } catch {
      // Never infer a later stage from an API failure; preserve independently confirmed stages.
    }
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
    if (row.draft !== false || !row.owner_approved || row.branch_ci !== "verified") return "merged_evidence_incomplete";
    if (row.postmerge === "verified") return "merge_ci_verified";
    if (row.postmerge === "failed") return "postmerge_failed";
    return "postmerge_unconfirmed";
  }
  return "unconfirmed";
}

export function formatCoderLifecycle({ rows = [], limited = false } = {}) {
  const lines = ["## INTEGRATOR — подтверждённые стадии Qwen после QA"];
  if (!rows.length) lines.push("Нет запусков с подтверждённой генерацией и QA в проверенной выборке.");
  for (const row of rows) {
    const label = {verified: "успешен", failed: "ошибка", pending: "ожидается", unconfirmed: "не подтверждён"};
    const ci = label[row.postmerge] || "не подтверждён";
    const branchCI = label[row.branch_ci] || "не подтверждён";
    const reviewState = {
      unconfirmed: "не подтверждён",
      closed_unmerged: "закрыт без merge; требуется решение по заданию",
      draft_waiting_review: "черновик; не готов к merge",
      approved_waiting_merge: "одобрен, ожидает merge",
      waiting_review_or_ci: "ожидает review или CI",
      merged_evidence_incomplete: "merge есть, доказательства одобрения или CI неполны",
      merge_ci_verified: "merge и CI подтверждены (не публикация)",
      postmerge_failed: "CI после merge не прошёл",
      postmerge_unconfirmed: "CI после merge не подтверждён",
    }[classifyReviewState(row)];
    lines.push("- Run " + row.run_id + ": " +
      (row.pr_created ? "PR #" + row.pr_number : "PR не подтверждён") +
      "; CI текущей ревизии PR: " + branchCI +
      "; одобрение владельца на точной ревизии: " + (row.owner_approved ? "подтверждено" : "не подтверждено") +
      "; merge: " + (row.merged ? "подтверждён" : "не подтверждён") +
      "; CI объединённого коммита: " + ci + "; состояние: " + reviewState + ".");
  }
  if (limited) lines.push("Достигнут лимит выборки; отчёт неполный.");
  lines.push("Это сверка метаданных GitHub, не постоянный журнал Supabase и не доказательство публикации сайта. CI текущей ревизии не доказывает совпадение с исходным patch модели. Merge без подтверждённого одобрения не считается одобрением.");
  return lines.join("\n");
}
