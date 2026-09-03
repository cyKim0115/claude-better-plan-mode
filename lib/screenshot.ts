// 워커 PC 화면 캡처 — 원격 에이전트가 "지금 화면이 어떤지" 확인할 때 쓴다.
// macOS: screencapture (GUI 세션 + 화면 기록 권한 필요 — launchd LaunchAgent로 띄워야 한다).
// Windows: PowerShell + System.Drawing. Linux: 미지원(오류 반환).
// 결과는 data/screenshots/에 남기고 최근 20장만 유지한다.

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data", "screenshots");
const KEEP = 20;
const MAX_DIM = Number(process.env.WORKER_SCREENSHOT_MAX_DIM ?? 1600);

export interface Screenshot {
  file: string;
  /** 보드 URL 경로 (/api/screenshots/<name>) */
  urlPath: string;
  bytes: number;
  mime: "image/png";
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => resolve({ code: null, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

export async function captureScreen(): Promise<Screenshot> {
  await fs.mkdir(DIR, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const file = path.join(DIR, name);

  let result: { code: number | null; stderr: string };
  if (process.platform === "darwin") {
    // -x: 셔터 소리 없음, -t png
    result = await run("screencapture", ["-x", "-t", "png", file]);
  } else if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
      "$g=[System.Drawing.Graphics]::FromImage($bmp);",
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
      `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    ].join(" ");
    result = await run("powershell", ["-NoProfile", "-Command", script]);
  } else {
    throw new Error(`이 플랫폼(${process.platform})은 화면 캡처를 지원하지 않습니다`);
  }

  if (result.code !== 0) {
    throw new Error(
      `화면 캡처 실패 (exit ${result.code}) ${result.stderr.trim()} — GUI 세션에서 실행 중인지, 화면 기록 권한이 있는지 확인하세요`
    );
  }
  // Retina 원본은 수 MB — MCP로 base64 전달하기엔 크므로 최대 변을 줄인다 (macOS sips)
  if (process.platform === "darwin") {
    await run("sips", ["-Z", String(MAX_DIM), file]);
  }
  const stat = await fs.stat(file);
  void pruneOld();
  return { file, urlPath: `/api/screenshots/${name}`, bytes: stat.size, mime: "image/png" };
}

export function screenshotPath(name: string): string {
  // 우리가 만든 파일명만 허용 (경로 조작 방지)
  if (!/^[0-9TZ-]+\.png$/.test(name)) throw new Error("invalid screenshot name");
  return path.join(DIR, name);
}

async function pruneOld() {
  try {
    const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".png")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      await fs.rm(path.join(DIR, f), { force: true });
    }
  } catch {
    /* noop */
  }
}
