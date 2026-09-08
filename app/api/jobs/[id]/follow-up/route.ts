import { NextRequest, NextResponse } from "next/server";
import { followUpJob } from "@/lib/jobs";
import { JOB_EFFORTS, type JobEffort } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 끝난 잡의 claude 세션을 이어서(--resume) 추가 지시를 수행 — 같은 잡에 이어붙이거나 새 잡 카드로 분리 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
    return NextResponse.json({ error: "prompt(추가 지시)가 필요합니다" }, { status: 400 });
  }
  if (body.effort !== undefined && !(JOB_EFFORTS as readonly unknown[]).includes(body.effort)) {
    return NextResponse.json({ error: `effort는 ${JOB_EFFORTS.join(" | ")}` }, { status: 400 });
  }
  try {
    const job = await followUpJob(id, {
      prompt: body.prompt,
      asNewJob: body.asNewJob === true,
      title: typeof body.title === "string" ? body.title : undefined,
      model: typeof body.model === "string" && body.model ? body.model : undefined,
      effort: body.effort as JobEffort | undefined,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
      skipVerify: body.skipVerify === true,
      port: Number(req.nextUrl.port) || 3000,
    });
    return NextResponse.json(
      { id: job.id, status: job.status, stage: job.stage, followUpCount: job.followUpCount, parentJobId: job.parentJobId },
      { status: body.asNewJob === true ? 201 : 200 }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
