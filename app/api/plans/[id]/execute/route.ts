import { NextRequest, NextResponse } from "next/server";
import { getPlan } from "@/lib/store";
import { startRun } from "@/lib/runner";
import { submitJob } from "@/lib/jobs";
import { JOB_EFFORTS, type JobEffort } from "@/lib/types";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as {
    taskIds?: string[];
    skipPermissions?: boolean;
    mode?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
  };
  if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
    return NextResponse.json({ error: "taskIds가 필요합니다" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "pr" && body.mode !== "direct") {
    return NextResponse.json({ error: "mode는 pr 또는 direct" }, { status: 400 });
  }
  if (body.effort !== undefined && !(JOB_EFFORTS as readonly string[]).includes(body.effort)) {
    return NextResponse.json({ error: `effort는 ${JOB_EFFORTS.join(" | ")}` }, { status: 400 });
  }
  if (body.model !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(body.model)) {
    return NextResponse.json({ error: "model 형식이 올바르지 않습니다" }, { status: 400 });
  }

  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });

  const port = Number(req.nextUrl.port) || 3000;
  const model = body.model || undefined;
  const effort = body.effort as JobEffort | undefined;

  try {
    // 프로젝트가 지정된 플랜은 잡 파이프라인 — worktree 격리 + 커밋 + PR/직푸시
    if (plan.project) {
      const job = await submitJob({
        project: plan.project,
        prompt: "",
        planId: plan.id,
        taskIds: body.taskIds,
        mode: body.mode as "pr" | "direct" | undefined,
        skipPermissions: body.skipPermissions === true,
        model,
        effort,
        maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
        port,
      });
      return NextResponse.json({ kind: "job", jobId: job.id, status: job.status, mode: job.mode });
    }

    // 레거시 플랜(경로만 지정) — workdir에서 그대로 실행, git 처리 없음
    if (body.mode) {
      return NextResponse.json(
        { error: "PR/직푸시는 프로젝트가 지정된 플랜에서만 가능합니다 (config/projects.json)" },
        { status: 400 }
      );
    }
    const run = await startRun({
      planId: id,
      taskIds: body.taskIds,
      skipPermissions: body.skipPermissions,
      model,
      effort,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
      port,
    });
    return NextResponse.json({ kind: "run", runId: run.id, status: run.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
