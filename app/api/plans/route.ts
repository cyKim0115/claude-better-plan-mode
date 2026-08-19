import { NextRequest, NextResponse } from "next/server";
import { listPlans, savePlan, getPlan, newId } from "@/lib/store";
import { generatePlan } from "@/lib/agent";
import { notifyPlanReady } from "@/lib/notify";
import type { Plan } from "@/lib/types";

export const maxDuration = 600;

export async function GET() {
  const plans = await listPlans();
  return NextResponse.json(
    plans.map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      workdir: p.workdir,
      revision: p.revision,
      updatedAt: p.updatedAt,
      taskCount: p.tasks.length,
      doneCount: p.tasks.filter((t) => t.status === "done").length,
    }))
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { goal?: string; workdir?: string; async?: boolean };
  if (!body.goal?.trim()) {
    return NextResponse.json({ error: "goal이 필요합니다" }, { status: 400 });
  }
  const goal = body.goal.trim();
  const workdir = body.workdir?.trim() ?? "";
  const port = Number(req.nextUrl.port) || 3000;

  // 비동기 모드: 스텁을 즉시 저장·반환하고 백그라운드에서 생성 (MCP 등 툴 호출용)
  if (body.async) {
    const now = new Date().toISOString();
    const stub: Plan = {
      id: newId(),
      title: goal.length > 60 ? `${goal.slice(0, 60)}…` : goal,
      goal,
      workdir,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      overview: "",
      phases: [],
      tasks: [],
      comments: [],
      history: [],
      generating: true,
    };
    await savePlan(stub);

    void (async () => {
      try {
        const generated = await generatePlan(goal, workdir);
        const current = await getPlan(stub.id);
        const done: Plan = {
          ...generated,
          id: stub.id,
          createdAt: stub.createdAt,
          // 생성 중에 달린 코멘트는 보존
          comments: current?.comments ?? [],
          generating: false,
        };
        await savePlan(done);
        void notifyPlanReady(done, port);
      } catch (e) {
        const current = await getPlan(stub.id);
        if (current) {
          current.generating = false;
          current.generateError = e instanceof Error ? e.message : String(e);
          await savePlan(current);
        }
      }
    })();

    return NextResponse.json(stub);
  }

  try {
    const plan = await generatePlan(goal, workdir);
    await savePlan(plan);
    void notifyPlanReady(plan, port);
    return NextResponse.json(plan);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
