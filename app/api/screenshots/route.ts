import { NextResponse } from "next/server";
import { captureScreen } from "@/lib/screenshot";

export const dynamic = "force-dynamic";

/** 워커 PC 화면을 지금 캡처하고 파일 정보를 돌려준다 */
export async function POST() {
  try {
    const shot = await captureScreen();
    return NextResponse.json({ url: shot.urlPath, bytes: shot.bytes, mime: shot.mime });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
