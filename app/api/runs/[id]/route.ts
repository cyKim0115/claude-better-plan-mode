import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runner";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  // since 파라미터로 증분 로그 폴링
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0");
  return NextResponse.json({
    id: run.id,
    planId: run.planId,
    taskIds: run.taskIds,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    logLength: run.log.length,
    log: run.log.slice(since),
  });
}
