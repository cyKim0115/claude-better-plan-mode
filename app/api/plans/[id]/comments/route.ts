import { NextRequest, NextResponse } from "next/server";
import { getPlan, savePlan, makeComment } from "@/lib/store";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as { taskId?: string | null; text?: string };
  if (!body.text?.trim()) return NextResponse.json({ error: "text가 필요합니다" }, { status: 400 });
  const comment = makeComment(body.taskId ?? null, body.text.trim());
  plan.comments.push(comment);
  await savePlan(plan);
  return NextResponse.json(plan);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const plan = await getPlan(id);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const commentId = req.nextUrl.searchParams.get("commentId");
  plan.comments = plan.comments.filter((c) => c.id !== commentId);
  await savePlan(plan);
  return NextResponse.json(plan);
}
