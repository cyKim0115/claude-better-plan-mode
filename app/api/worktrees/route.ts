import { NextRequest, NextResponse } from "next/server";
import { lastWorktreeGc, runWorktreeGc } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** 남아 있는 worktree 현황 (지우지 않음). ?size=1이면 du로 용량까지 잰다 — 느릴 수 있다 */
export async function GET(req: NextRequest) {
  const measure = req.nextUrl.searchParams.get("size") === "1";
  try {
    const scan = await runWorktreeGc({ dryRun: true, measure });
    return NextResponse.json({ scan, lastRun: lastWorktreeGc() ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** 즉시 정리. force면 보관 기한을 무시하고, includeUnsaved면 저장 안 된 변경이 남은 것까지 지운다 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const result = await runWorktreeGc(
      {
        force: body.force === true,
        includeUnsaved: body.includeUnsaved === true,
        measure: body.measure === true,
      },
      Number(req.nextUrl.port) || 3000
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
