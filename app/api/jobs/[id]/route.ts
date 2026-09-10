import { NextRequest, NextResponse } from "next/server";
import { getJob, updateQueuedJob } from "@/lib/jobs";
import { JOB_EFFORTS, type JobEffort, type JobMode } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 잡 상세 — since 파라미터로 증분 로그 폴링 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0");
  const { log, ...meta } = job;
  return NextResponse.json({ ...meta, logLength: log.length, log: log.slice(since) });
}

/** 아직 시작하지 않은(queued) 잡의 제출 옵션 수정. 빈 문자열 model/effort는 "기본으로 되돌리기" */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "본문이 필요합니다" }, { status: 400 });
  if (body.mode !== undefined && body.mode !== "pr" && body.mode !== "direct") {
    return NextResponse.json({ error: "mode는 pr 또는 direct" }, { status: 400 });
  }
  if (body.effort !== undefined && body.effort !== "" && body.effort !== null && !(JOB_EFFORTS as readonly unknown[]).includes(body.effort)) {
    return NextResponse.json({ error: `effort는 ${JOB_EFFORTS.join(" | ")}` }, { status: 400 });
  }
  try {
    const job = await updateQueuedJob(id, {
      title: typeof body.title === "string" ? body.title : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      mode: body.mode as JobMode | undefined,
      model: typeof body.model === "string" ? (body.model || null) : body.model === null ? null : undefined,
      effort: typeof body.effort === "string" ? ((body.effort || null) as JobEffort | null) : body.effort === null ? null : undefined,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : body.maxTurns === null ? null : undefined,
      skipVerify: typeof body.skipVerify === "boolean" ? body.skipVerify : undefined,
      capture: typeof body.capture === "boolean" ? body.capture : undefined,
      skipPermissions: typeof body.skipPermissions === "boolean" ? body.skipPermissions : undefined,
    });
    return NextResponse.json({
      id: job.id,
      status: job.status,
      title: job.title,
      mode: job.mode,
      model: job.model,
      effort: job.effort,
      skipVerify: job.skipVerify === true,
      capture: job.capture === true,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
