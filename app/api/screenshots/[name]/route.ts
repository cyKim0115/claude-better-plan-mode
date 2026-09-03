import { promises as fs } from "fs";
import { NextResponse } from "next/server";
import { screenshotPath } from "@/lib/screenshot";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  try {
    const buf = await fs.readFile(screenshotPath(name));
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
