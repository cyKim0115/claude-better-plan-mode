import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const job = await cancelJob(id);
    return NextResponse.json({ id: job.id, status: job.status, stage: job.stage });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
