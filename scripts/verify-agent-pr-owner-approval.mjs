const OWNER_LOGIN = "spartakdubov059";
const REPOSITORY = "spartakdubov059/fam-website";
const AUTOMATION_BRANCH_PREFIX = "codex/fam-run-";
const API_ROOT = "https://api.github.com";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function hasCurrentOwnerApproval(reviews, headSha, ownerLogin = OWNER_LOGIN) {
  if (!Array.isArray(reviews) || !SHA_PATTERN.test(String(headSha ?? ""))) return false;
  const ownerReviews = reviews
    .filter((review) =>
      String(review?.user?.login ?? "").toLowerCase() === ownerLogin.toLowerCase() &&
      typeof review?.submitted_at === "string" &&
      Number.isFinite(Date.parse(review.submitted_at)),
    )
    .sort((a, b) =>
      Date.parse(a.submitted_at) - Date.parse(b.submitted_at) ||
      (Number.isSafeInteger(a.id) ? a.id : 0) - (Number.isSafeInteger(b.id) ? b.id : 0),
    );
  const latest = ownerReviews.at(-1);
  return latest?.state === "APPROVED" &&
    typeof latest.commit_id === "string" &&
    latest.commit_id.toLowerCase() === headSha.toLowerCase();
}

async function fetchOwnerReviews(repository, pullNumber, token) {
  const reviews = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = API_ROOT + "/repos/" + repository +
      "/pulls/" + pullNumber + "/reviews?per_page=100&page=" + page;
    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("approval_review_fetch_failed");
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("approval_review_response_invalid");
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
  throw new Error("approval_review_history_limit");
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const baseRef = process.env.PR_BASE_REF ?? "";
  const headRef = process.env.PR_HEAD_REF ?? "";
  const pullNumber = process.env.PR_NUMBER ?? "";
  const headSha = process.env.PR_HEAD_SHA ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const baseSha = process.env.APPROVAL_BASE_SHA ?? "";
  if (baseRef !== "main" || !headRef.startsWith(AUTOMATION_BRANCH_PREFIX)) {
    console.log("Owner approval gate not applicable to this pull request.");
    return;
  }
  if (repository !== REPOSITORY || !/^[1-9][0-9]*$/.test(pullNumber) ||
      !SHA_PATTERN.test(headSha) || !SHA_PATTERN.test(baseSha) || !token) {
    throw new Error("approval_gate_configuration_invalid");
  }
  const reviews = await fetchOwnerReviews(repository, pullNumber, token);
  if (!hasCurrentOwnerApproval(reviews, headSha)) {
    console.error("Owner approval for the current agent PR revision is missing or stale.");
    process.exitCode = 1;
    return;
  }
  console.log("Owner approval verified for the current agent PR revision.");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
