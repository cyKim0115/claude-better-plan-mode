import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

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
