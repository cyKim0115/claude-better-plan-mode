import { NextRequest, NextResponse } from "next/server";
import { getPlan, savePlan } from "@/lib/store";
import { revisePlan } from "@/lib/agent";

export const maxDuration = 600;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const open = plan.comments.filter((c) => !c.resolved);
  if (open.length === 0) {
    return NextResponse.json({ error: "반영할 미해결 코멘트가 없습니다" }, { status: 400 });
  }
  try {
    const revised = await revisePlan(plan, open);
    await savePlan(revised);
    return NextResponse.json(revised);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
