import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { jobCapturePath } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** 확장자 → Content-Type. 여기 없는 확장자는 애초에 수집되지 않는다 */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** 잡이 남긴 캡처 파일 하나를 내려준다 (data/jobs/<id>-captures/<name>) */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await ctx.params;
  const mime = MIME[path.extname(name).toLowerCase()];
  if (!mime) return NextResponse.json({ error: "unsupported type" }, { status: 400 });
  try {
    const buf = await fs.readFile(jobCapturePath(id, name));
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
