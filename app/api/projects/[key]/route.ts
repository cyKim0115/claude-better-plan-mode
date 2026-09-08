import { NextRequest, NextResponse } from "next/server";
import { setProjectAllowDirect } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** 프로젝트 설정 변경 — 지금은 직푸시 허용(allowDirect)만 바꿀 수 있다 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.allowDirect !== "boolean") {
    return NextResponse.json({ error: "allowDirect(boolean)가 필요합니다" }, { status: 400 });
  }
  try {
    const cfg = await setProjectAllowDirect(key, body.allowDirect);
    return NextResponse.json({ key, allowDirect: cfg.allowDirect !== false, baseBranch: cfg.baseBranch });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
