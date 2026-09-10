import { NextRequest, NextResponse } from "next/server";
import { listJobs, submitJob, loadProjects } from "@/lib/jobs";
import { JOB_EFFORTS, type Job, type JobEffort, type ProjectConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

function summarize(j: Job) {
  return {
    id: j.id,
    project: j.project,
    title: j.title,
    mode: j.mode,
    model: j.model,
    effort: j.effort,
    status: j.status,
    stage: j.stage,
    verify: j.verify,
    skipVerify: j.skipVerify,
    capture: j.capture,
    captures: j.captures,
    captureError: j.captureError,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    lastActivityAt: j.lastActivityAt,
    branch: j.branch,
    worktreeRemovedAt: j.worktreeRemovedAt,
    prUrl: j.prUrl,
    commitCount: j.commitCount,
    error: j.error,
    resumeCount: j.resumeCount,
    followUpCount: j.followUpCount,
    parentJobId: j.parentJobId,
    startBranch: j.startBranch,
  };
}

function projectSummary(key: string, p: ProjectConfig) {
  return {
    key,
    baseBranch: p.baseBranch,
    allowDirect: p.allowDirect !== false,
    unityVerify: Boolean(p.unityPath),
    capture: Boolean(p.unityPath && p.captureMethod),
    defaultModel: p.defaultModel,
    defaultEffort: p.defaultEffort,
  };
}

/** 잡 목록 + 등록된 프로젝트 목록 */
export async function GET() {
  const jobs = await listJobs();
  let projects: ReturnType<typeof projectSummary>[] = [];
  try {
    projects = Object.entries(await loadProjects()).map(([k, p]) => projectSummary(k, p));
  } catch {
    // 설정 파일이 없으면 빈 목록 — 제출 시 오류로 안내된다
  }
  return NextResponse.json({ projects, efforts: JOB_EFFORTS, jobs: jobs.map(summarize) });
}

/** 잡 제출 — 즉시 id를 돌려주고 백그라운드 큐에서 실행 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.project !== "string" || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "project, prompt가 필요합니다" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "pr" && body.mode !== "direct") {
    return NextResponse.json({ error: "mode는 pr 또는 direct" }, { status: 400 });
  }
  if (body.effort !== undefined && !(JOB_EFFORTS as readonly unknown[]).includes(body.effort)) {
    return NextResponse.json({ error: `effort는 ${JOB_EFFORTS.join(" | ")}` }, { status: 400 });
  }
  if (body.startFrom !== undefined && body.startFrom !== "base" && body.startFrom !== "parent") {
    return NextResponse.json({ error: "startFrom은 base 또는 parent" }, { status: 400 });
  }
  try {
    const job = await submitJob({
      project: body.project,
      prompt: body.prompt,
      title: typeof body.title === "string" ? body.title : undefined,
      mode: body.mode as "pr" | "direct" | undefined,
      skipPermissions: body.skipPermissions === true,
      skipVerify: body.skipVerify === true,
      capture: body.capture === true,
      model: typeof body.model === "string" && body.model ? body.model : undefined,
      effort: body.effort as JobEffort | undefined,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
      parentJobId: typeof body.parentJobId === "string" && body.parentJobId ? body.parentJobId : undefined,
      startFrom: body.startFrom as "base" | "parent" | undefined,
      port: Number(req.nextUrl.port) || 3000,
    });
    return NextResponse.json({ id: job.id, status: job.status, branch: job.branch }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
