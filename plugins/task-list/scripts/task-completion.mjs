import fs from "node:fs";
import { createHash } from "node:crypto";
import { taskPath, fail } from "./task-store.mjs";

export function currentReport(item, report) {
  return report.attemptId === item.attemptId && report.specRevision === item.specRevision;
}
function unmetMechanical(root, item, report) {
  const unmet = [];
  for (const policy of item.completionPolicy) {
    if (policy.verifier !== "sha256") continue;
    if (policy.evidenceType !== "file" || !/^[a-f0-9]{64}$/.test(policy.expectedSha256 ?? "")) {
      fail("INVALID_POLICY", "sha256 條件須指定 file 與 expectedSha256");
    }
    if (!report.evidence.includes(policy.target)) { unmet.push(policy.criterion); continue; }
    try {
      const file = taskPath(root, policy.target);
      const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (hash !== policy.expectedSha256) unmet.push(policy.criterion);
    } catch (error) {
      if (error.code === "UNSAFE_PATH") throw error;
      unmet.push(policy.criterion);
    }
  }
  return unmet;
}
// Only sha256 is mechanical; other verifier names require explicit review.
export function evaluateCompletion(root, item, report, now, review) {
  if (!currentReport(item, report)) { report.history = true; return; }
  if (item.status === "cancelled" || item.status === "done") { report.history = true; return; }
  if (report.outcome !== "success") {
    item.status = "blocked";
    item.nextAction = "修正報告指出的未滿足條件";
    return;
  }
  const unmet = unmetMechanical(root, item, report);
  const semantic = item.completionPolicy.some((policy) => policy.verifier !== "sha256");
  report.unmetCriteria = unmet;
  if (unmet.length) {
    item.status = "blocked";
    item.nextAction = "補足報告中的完成條件";
  } else if (semantic) {
    if (!review || typeof review.reviewer !== "string" || !review.reviewer.trim()
      || typeof review.nextAction !== "string" || !review.nextAction.trim()
      || !Number.isFinite(Date.parse(review.revisitAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(review.revisitAt)
      || Date.parse(review.revisitAt) <= Date.parse(now)) fail("REVIEW_REQUIRED", "待驗收須指定驗收者、未來 revisitAt 與下一步");
    item.status = "review";
    item.review = { reviewer: review.reviewer, requestedAt: now, revisitAt: review.revisitAt, nextAction: review.nextAction, reportId: report.id };
    item.revisitAt = review.revisitAt;
    item.nextAction = review.nextAction;
  } else {
    report.acceptance = { status: "accepted", by: "sha256", at: now };
    item.status = "done";
    item.nextAction = "保留完成證據";
    delete item.review;
  }
}
export function propagateCompletion(state) {
  for (const group of state.items.filter((item) => item.kind === "group" && item.status !== "cancelled")) {
    const children = state.items.filter((item) => item.parentId === group.id && item.status !== "cancelled");
    if (children.length && children.every((item) => item.status === "done")) {
      group.status = "done";
      group.nextAction = "所有有效子項已完成";
    } else if (group.status === "done") {
      group.status = "queued";
      group.nextAction = "完成剩餘有效子項";
    }
  }
}
export function acceptReport(root, state, report, by, now) {
  const item = state.items.find((entry) => entry.id === report.itemId);
  if (report.history || !currentReport(item, report)) fail("STALE_REPORT", "舊報告只保留歷史，不可完成目前工作");
  if (item.status !== "review" || item.review?.reportId !== report.id || report.acceptance.status !== "pending") fail("NOT_REVIEW", "報告不是目前待驗收交付");
  if (item.review.reviewer !== by) fail("REVIEWER_MISMATCH", "必須由指定驗收者驗收");
  if (report.outcome !== "success" || report.unmetCriteria?.length || unmetMechanical(root, item, report).length) fail("UNMET_CRITERIA", "完成條件尚未滿足");
  report.acceptance = { status: "accepted", by, at: now };
  item.status = "done";
  item.nextAction = "保留完成證據";
  delete item.review;
}
