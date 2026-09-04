import { NextRequest, NextResponse } from "next/server";
import { listPlans, savePlan, getPlan, newId } from "@/lib/store";
import { generatePlan, type GeneratePlanOptions } from "@/lib/agent";
import { loadProjects } from "@/lib/jobs";
import { notifyPlanReady } from "@/lib/notify";
import { JOB_EFFORTS, type JobEffort, type Plan } from "@/lib/types";

export const maxDuration = 600;

export async function GET() {
  const plans = await listPlans();
  return NextResponse.json(
    plans.map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      workdir: p.workdir,
      project: p.project,
      revision: p.revision,
      updatedAt: p.updatedAt,
      taskCount: p.tasks.length,
      doneCount: p.tasks.filter((t) => t.status === "done").length,
    }))
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    goal?: string;
    workdir?: string;
    project?: string;
    model?: string;
    effort?: string;
    async?: boolean;
  };
  if (!body.goal?.trim()) {
    return NextResponse.json({ error: "goal이 필요합니다" }, { status: 400 });
  }
  const goal = body.goal.trim();
  let workdir = body.workdir?.trim() ?? "";
  const port = Number(req.nextUrl.port) || 3000;

  // 프로젝트를 고르면 workdir·baseBranch·검증 설정을 config/projects.json에서 가져온다
  const project = body.project?.trim() || undefined;
  if (project) {
    let cfgPath: string | undefined;
    try {
      cfgPath = (await loadProjects())[project]?.path;
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    if (!cfgPath) return NextResponse.json({ error: `알 수 없는 프로젝트: ${project}` }, { status: 400 });
    workdir = cfgPath;
  }

  const model = body.model?.trim() || undefined;
  if (model !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) {
    return NextResponse.json({ error: "model 형식이 올바르지 않습니다" }, { status: 400 });
  }
  const effort = body.effort?.trim() || undefined;
  if (effort !== undefined && !(JOB_EFFORTS as readonly string[]).includes(effort)) {
    return NextResponse.json({ error: `effort는 ${JOB_EFFORTS.join(" | ")}` }, { status: 400 });
  }
  const agentOpts: GeneratePlanOptions = { project, model, effort: effort as JobEffort | undefined };

  // 비동기 모드: 스텁을 즉시 저장·반환하고 백그라운드에서 생성 (MCP 등 툴 호출용)
  if (body.async) {
    const now = new Date().toISOString();
    const stub: Plan = {
      id: newId(),
      title: goal.length > 60 ? `${goal.slice(0, 60)}…` : goal,
      goal,
      workdir,
      project,
      planModel: model,
      planEffort: effort as JobEffort | undefined,
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
        const generated = await generatePlan(goal, workdir, agentOpts);
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
    const plan = await generatePlan(goal, workdir, agentOpts);
    await savePlan(plan);
    void notifyPlanReady(plan, port);
    return NextResponse.json(plan);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
