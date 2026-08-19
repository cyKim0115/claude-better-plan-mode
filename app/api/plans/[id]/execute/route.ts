import { NextRequest, NextResponse } from "next/server";
import { startRun } from "@/lib/runner";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { taskIds?: string[]; skipPermissions?: boolean };
  if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
    return NextResponse.json({ error: "taskIds가 필요합니다" }, { status: 400 });
  }
  try {
    const run = await startRun({
      planId: id,
      taskIds: body.taskIds,
      skipPermissions: body.skipPermissions,
      port: Number(req.nextUrl.port) || 3000,
    });
    return NextResponse.json({ runId: run.id, status: run.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
