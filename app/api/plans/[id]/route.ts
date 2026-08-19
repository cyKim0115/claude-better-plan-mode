import { NextRequest, NextResponse } from "next/server";
import { getPlan, savePlan, deletePlan } from "@/lib/store";
import { listRunsForPlan } from "@/lib/runner";
import type { TaskStatus } from "@/lib/types";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ plan, runs: listRunsForPlan(id).map(({ log, ...r }) => ({ ...r, logLength: log.length })) });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as {
    taskStatus?: { taskId: string; status: TaskStatus };
    workdir?: string;
  };
  if (body.taskStatus) {
    const t = plan.tasks.find((t) => t.id === body.taskStatus!.taskId);
    if (t) t.status = body.taskStatus.status;
  }
  if (typeof body.workdir === "string") plan.workdir = body.workdir;
  await savePlan(plan);
  return NextResponse.json(plan);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deletePlan(id);
  return NextResponse.json({ ok: true });
}
