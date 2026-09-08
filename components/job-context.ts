// 이어서하기·새 세션 폼이 보여 주는 이전 잡 요약.
// 서버 페이지(app/jobs/[id]/**)에서 만들어 클라이언트 폼에 넘긴다 — 폼이 lib/jobs를 직접 읽지 않게.

import type { Job, JobEffort, JobMode, JobStatus, JobVerifyResult } from "@/lib/types";

export interface JobContext {
  id: string;
  project: string;
  title: string;
  prompt: string;
  status: JobStatus;
  stage: string;
  mode: JobMode;
  model?: string;
  effort?: JobEffort;
  baseBranch: string;
  branch?: string;
  startBranch?: string;
  worktree?: string;
  worktreeRemovedAt?: string;
  prUrl?: string;
  verify?: JobVerifyResult;
  commitCount?: number;
  planId?: string;
  parentJobId?: string;
  followUpCount?: number;
  endedAt?: string;
  error?: string;
  /** claude 세션 id를 알고 있는지 — 모르면 worktree의 최근 세션을 --continue로 잇는다 */
  hasSession: boolean;
  /** 마지막 result 로그 = 세션이 남긴 요약 */
  resultSummary: string;
}

export function toJobContext(job: Job): JobContext {
  const result = [...job.log].reverse().find((l) => l.kind === "result");
  return {
    id: job.id,
    project: job.project,
    title: job.title,
    prompt: job.prompt,
    status: job.status,
    stage: job.stage,
    mode: job.mode,
    model: job.model,
    effort: job.effort,
    baseBranch: job.baseBranch,
    branch: job.branch,
    startBranch: job.startBranch,
    worktree: job.worktree,
    worktreeRemovedAt: job.worktreeRemovedAt,
    prUrl: job.prUrl,
    verify: job.verify,
    commitCount: job.commitCount,
    planId: job.planId,
    parentJobId: job.parentJobId,
    followUpCount: job.followUpCount,
    endedAt: job.endedAt,
    error: job.error,
    hasSession: Boolean(job.sessionId),
    resultSummary: result?.text ?? "(세션 요약 없음)",
  };
}

/** 이어서하기 가능 여부 — worktree가 살아 있고, 잡이 끝나 있어야 한다 */
export function canFollowUp(ctx: JobContext): { ok: boolean; reason: string } {
  if (ctx.status === "running" || ctx.status === "queued") return { ok: false, reason: `아직 ${ctx.status} 상태입니다 — 끝난 뒤에 이어서 하세요` };
  if (!ctx.worktree || !ctx.branch) return { ok: false, reason: "worktree 정보가 없습니다 (새 세션으로 시작하세요)" };
  if (ctx.worktreeRemovedAt) return { ok: false, reason: `worktree가 정리됐습니다 (${new Date(ctx.worktreeRemovedAt).toLocaleString("ko-KR")}) — 새 세션으로 시작하세요` };
  return { ok: true, reason: "" };
}
