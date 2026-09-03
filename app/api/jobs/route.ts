import { NextRequest, NextResponse } from "next/server";
import { listJobs, submitJob, loadProjects } from "@/lib/jobs";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";

function summarize(j: Job) {
  return {
    id: j.id,
    project: j.project,
    title: j.title,
    mode: j.mode,
    status: j.status,
    stage: j.stage,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    branch: j.branch,
    prUrl: j.prUrl,
    commitCount: j.commitCount,
    error: j.error,
  };
}

/** 잡 목록 + 등록된 프로젝트 목록 */
export async function GET() {
  const jobs = await listJobs();
  let projects: string[] = [];
  try {
    projects = Object.keys(await loadProjects());
  } catch {
    // 설정 파일이 없으면 빈 목록 — 제출 시 오류로 안내된다
  }
  return NextResponse.json({ projects, jobs: jobs.map(summarize) });
}

/** 잡 제출 — 즉시 id를 돌려주고 백그라운드 큐에서 실행 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    project?: unknown;
    prompt?: unknown;
    title?: unknown;
    mode?: unknown;
    skipPermissions?: unknown;
  } | null;
  if (!body || typeof body.project !== "string" || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "project, prompt가 필요합니다" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "pr" && body.mode !== "direct") {
    return NextResponse.json({ error: "mode는 pr 또는 direct" }, { status: 400 });
  }
  try {
    const job = await submitJob({
      project: body.project,
      prompt: body.prompt,
      title: typeof body.title === "string" ? body.title : undefined,
      mode: body.mode as "pr" | "direct" | undefined,
      skipPermissions: body.skipPermissions === true,
      port: Number(req.nextUrl.port) || 3000,
    });
    return NextResponse.json({ id: job.id, status: job.status, branch: job.branch }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
