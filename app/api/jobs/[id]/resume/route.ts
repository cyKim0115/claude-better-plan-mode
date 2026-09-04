import { NextRequest, NextResponse } from "next/server";
import { resumeJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** 실패·취소·중단된 잡을 worktree 그대로 두고 커밋 단계부터 이어서 마무리 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { skipVerify?: unknown };
  try {
    const job = await resumeJob(id, {
      skipVerify: body.skipVerify === true,
      port: Number(req.nextUrl.port) || 3000,
    });
    return NextResponse.json({ id: job.id, status: job.status, stage: job.stage, resumeCount: job.resumeCount });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
