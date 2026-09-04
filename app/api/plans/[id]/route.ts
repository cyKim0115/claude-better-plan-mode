import { NextRequest, NextResponse } from "next/server";
import { getPlan, savePlan, deletePlan } from "@/lib/store";
import { listRunsForPlan } from "@/lib/runner";
import { listJobs, loadProjects } from "@/lib/jobs";
import type { TaskStatus } from "@/lib/types";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const jobs = (await listJobs())
    .filter((j) => j.planId === id)
    .map((j) => ({
      id: j.id,
      title: j.title,
      taskIds: j.taskIds ?? [],
      mode: j.mode,
      model: j.model,
      effort: j.effort,
      status: j.status,
      stage: j.stage,
      verify: j.verify,
      branch: j.branch,
      prUrl: j.prUrl,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      lastActivityAt: j.lastActivityAt,
      error: j.error,
    }));
  return NextResponse.json({
    plan,
    runs: listRunsForPlan(id).map(({ log, ...r }) => ({ ...r, logLength: log.length })),
    jobs,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as {
    taskStatus?: { taskId: string; status: TaskStatus };
    workdir?: string;
    /** config/projects.json 키. 빈 문자열이면 연결 해제 */
    project?: string;
  };
  if (body.taskStatus) {
    const t = plan.tasks.find((t) => t.id === body.taskStatus!.taskId);
    if (t) t.status = body.taskStatus.status;
  }
  if (typeof body.workdir === "string") plan.workdir = body.workdir;
  if (typeof body.project === "string") {
    const key = body.project.trim();
    if (!key) {
      plan.project = undefined;
    } else {
      const cfg = (await loadProjects())[key];
      if (!cfg) return NextResponse.json({ error: `알 수 없는 프로젝트: ${key}` }, { status: 400 });
      plan.project = key;
      plan.workdir = cfg.path;
    }
  }
  await savePlan(plan);
  return NextResponse.json(plan);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deletePlan(id);
  return NextResponse.json({ ok: true });
}
