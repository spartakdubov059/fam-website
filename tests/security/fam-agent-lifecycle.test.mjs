import test from "node:test";
import assert from "node:assert/strict";
import { collectCoderLifecycle, ownerApproval, exactPostMergeCI, exactBranchCI, formatCoderLifecycle, classifyReviewState } from "../../scripts/fam-agent-lifecycle.mjs";

const repository = "owner/fam";
const head = "a".repeat(40), merged = "b".repeat(40);
const when = "2026-11-23T12:00:00Z";
const after = "2026-11-23T12:10:00Z";
const before = "2026-11-23T11:00:00Z";
const pr = { number: 7, user: {login: "github-actions[bot]"},
  base: {ref:"main", repo:{full_name:repository}},
  head: {ref:"codex/fam-run-123", sha:head, repo:{full_name:repository}},
  created_at:before, state:"closed", merged:true, merged_at:when, merge_commit_sha:merged };
const run = { id:123, head_branch:"main", jobs:[
  { name:"Локальная модель готовит исправление", status:"completed", conclusion:"success",
    steps:[{name:"Запустить локальную модель и подготовить patch", conclusion:"success"}] },
  { name:"Независимая проверка без модели и секретов", status:"completed", conclusion:"success" }
]};
const review = { id:1, user:{login:"owner"}, state:"APPROVED", submitted_at:before, commit_id:head };
const ci = { id:444, head_sha:merged, head_branch:"main", event:"push", created_at:after, status:"completed", conclusion:"success" };
const branchCI = {...ci,id:443,head_sha:head,head_branch:"codex/fam-run-123",event:"workflow_dispatch",created_at:when};

test("owner approval is exact-head, owner-only and not inferred from merge", () => {
  assert.equal(ownerApproval([review], "owner", head, when), true);
  for (const bad of [
    [{...review,user:{login:"other"}}], [{...review,commit_id:merged}],
    [{...review,submitted_at:after}], [{...review,state:"DISMISSED"}],
    [review,{...review,id:2,submitted_at:when,state:"CHANGES_REQUESTED"}]
  ]) assert.equal(ownerApproval(bad,"owner",head,when),false);
});

test("post-merge verification requires main push CI on exact merge SHA", () => {
  assert.equal(exactPostMergeCI([ci],merged,when),"verified");
  for (const bad of [{...ci,head_sha:head},{...ci,event:"pull_request"},
    {...ci,head_branch:"feature"},{...ci,created_at:before}])
    assert.equal(exactPostMergeCI([bad],merged,when),"unconfirmed");
  assert.equal(exactPostMergeCI([ci,{...ci,id:445,status:"in_progress",conclusion:null}],merged,when),"pending");
  assert.equal(exactPostMergeCI([ci,{...ci,id:445,conclusion:"failure"}],merged,when),"failed");
});

test("lifecycle reconciles only trusted bot PR and independently verified stages", async () => {
  const calls=[];
  const result = await collectCoderLifecycle({runs:[run,run],repository,read:async path=>{
    calls.push(path);
    if (path.startsWith("/pulls?")) return [pr];
    if (path==="/pulls/7") return pr;
    if (path.startsWith("/pulls/7/reviews")) return [review];
    if (path.includes("event=workflow_dispatch")) return {workflow_runs:[branchCI]};
    if (path.startsWith("/actions/workflows/")) return {workflow_runs:[ci]};
    throw Error("unexpected endpoint");
  }});
  assert.equal(calls.length,5);
  assert.equal(result.rows.length,1);
  assert.deepEqual(result.rows[0],{run_id:123,pr_number:7,pr_created:true,
    owner_approved:true,merged:true,pr_state:"merged",branch_ci:"verified",postmerge:"verified",evidence:"review_checked"});
  assert.match(formatCoderLifecycle(result), /PR #7/);
  assert.match(formatCoderLifecycle(result), /CI объединённого коммита: успешен/);
});

test("missing review, unrelated PR, partial metadata never imply authorization", async () => {
  const withoutReview = await collectCoderLifecycle({runs:[run],repository,read:async path=>{
    if (path.startsWith("/pulls?")) return [pr];
    if (path==="/pulls/7") return pr;
    throw Error("API unavailable");
  }});
  assert.equal(withoutReview.rows[0].merged,true);
  assert.equal(withoutReview.rows[0].owner_approved,false);
  assert.equal(withoutReview.rows[0].postmerge,"unconfirmed");
  const spoof = await collectCoderLifecycle({runs:[run],repository,read:async()=>[
    {...pr,user:{login:"owner"}},{...pr,head:{...pr.head,repo:{full_name:"fork/fam"}}}
  ]});
  assert.equal(spoof.rows[0].pr_created,false);
  assert.equal(spoof.rows[0].merged,false);
  const noQa = await collectCoderLifecycle({runs:[{...run,jobs:[run.jobs[0]]}],repository,read:async()=>{throw Error("must not call");}});
  assert.deepEqual(noQa.rows,[]);
  const limited = await collectCoderLifecycle({runs:[run],repository,limit:0,read:async()=>{throw Error("must not call");}});
  assert.equal(limited.limited,true);
  assert.deepEqual(limited.rows,[]);
});

test("branch CI is tied to exact current head, run branch and dispatch after PR creation", () => {
  assert.equal(exactBranchCI([branchCI],head,123,before),"verified");
  for (const bad of [{...branchCI,head_sha:merged},{...branchCI,head_branch:"codex/fam-run-124"},
    {...branchCI,event:"push"},{...branchCI,created_at:"2026-11-22T10:00:00Z"}])
    assert.equal(exactBranchCI([bad],head,123,before),"unconfirmed");
  assert.equal(exactBranchCI([branchCI,{...branchCI,id:446,conclusion:"failure"}],head,123,before),"failed");
});
test("unavailable review and branch CI do not conceal independently proven postmerge CI", async () => {
  const result = await collectCoderLifecycle({runs:[run],repository,read:async path=>{
    if(path.startsWith("/pulls?")) return [pr];
    if(path==="/pulls/7") return pr;
    if(path.includes("event=push")) return {workflow_runs:[ci]};
    throw Error("unavailable");
  }});
  assert.equal(result.rows[0].owner_approved,false);
  assert.equal(result.rows[0].branch_ci,"unconfirmed");
  assert.equal(result.rows[0].postmerge,"verified");
});
test("new PR head cannot inherit successful CI or owner approval from earlier revision", async () => {
  const changed={...pr,head:{...pr.head,sha:"c".repeat(40)},state:"open",merged:false,merged_at:null};
  const result=await collectCoderLifecycle({runs:[run],repository,read:async path=>{
    if(path.startsWith("/pulls?")) return [changed];
    if(path==="/pulls/7") return changed;
    if(path.includes("/reviews?")) return [review];
    if(path.includes("event=workflow_dispatch")) return {workflow_runs:[branchCI]};
    throw Error("unexpected endpoint");
  }});
  assert.equal(result.rows[0].pr_created,true);
  assert.equal(result.rows[0].owner_approved,false);
  assert.equal(result.rows[0].branch_ci,"unconfirmed");
  assert.equal(result.rows[0].merged,false);
});

test("pending review, closed unmerged and verified merge remain distinct and read-only", async () => {
  for (const [state, mergedFlag, expected] of [
    ["open",false,"approved_waiting_merge"],
    ["closed",false,"closed_unmerged"],
    ["closed",true,"merge_ci_verified"],
    ["open",true,"unconfirmed"],
    [undefined,false,"unconfirmed"],
  ]) {
    const candidate={...pr,state,merged:mergedFlag,merged_at:mergedFlag?when:null};
    const result=await collectCoderLifecycle({runs:[run],repository,read:async path=>{
      if(path.startsWith("/pulls?")) return [candidate];
      if(path==="/pulls/7") return candidate;
      if(path.includes("/reviews?")) return [review];
      if(path.includes("event=workflow_dispatch")) return {workflow_runs:[branchCI]};
      if(path.includes("event=push")) return {workflow_runs:[ci]};
      throw Error("unexpected endpoint");
    }});
    assert.equal(classifyReviewState(result.rows[0]),expected);
  }
  const ready={pr_created:true,pr_state:"merged",merged:true,owner_approved:true,branch_ci:"verified",postmerge:"verified"};
  assert.equal(classifyReviewState({...ready,owner_approved:false}),"merged_evidence_incomplete");
  assert.equal(classifyReviewState({...ready,branch_ci:"unconfirmed"}),"merged_evidence_incomplete");
  assert.equal(classifyReviewState({...ready,postmerge:"failed"}),"postmerge_failed");
  assert.equal(classifyReviewState({...ready,postmerge:"pending"}),"postmerge_unconfirmed");
});
