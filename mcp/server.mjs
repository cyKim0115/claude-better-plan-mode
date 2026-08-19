#!/usr/bin/env node
/**
 * Better Plan Mode — MCP 서버 (stdio)
 *
 * Claude Code 등 MCP 호스트에 등록해두면, 플랜 관련 툴이 호출될 때만
 * 플랜 보드 웹서버(next)를 온디맨드로 띄우고, 유휴 시간이 지나면 자동 종료한다.
 *
 * 등록 예:
 *   claude mcp add planmode -- node C:\Users\cykim\repo\claude-better-plan-mode\mcp\server.mjs
 *
 * 환경변수:
 *   PLANMODE_PORT          기본 3123
 *   PLANMODE_MODE          "dev"(기본) | "start" (start는 사전에 next build 필요)
 *   PLANMODE_IDLE_MINUTES  유휴 자동 종료(분), 기본 30, 0이면 끄지 않음
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PLANMODE_PORT || 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const MODE = process.env.PLANMODE_MODE === "start" ? "start" : "dev";
const IDLE_MINUTES = Number(process.env.PLANMODE_IDLE_MINUTES ?? 30);

/** 우리가 스폰한 next 프로세스 (다른 곳에서 이미 떠 있으면 null 유지 → 죽이지 않음) */
let child = null;
let idleTimer = null;

function log(msg) {
  // stdout은 MCP 프로토콜 전용 — 로그는 stderr로만
  process.stderr.write(`[planmode-mcp] ${msg}\n`);
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (IDLE_MINUTES > 0) {
    idleTimer = setTimeout(() => {
      log(`유휴 ${IDLE_MINUTES}분 경과 — 보드 서버 종료`);
      stopServer();
    }, IDLE_MINUTES * 60 * 1000);
    idleTimer.unref?.();
  }
}

async function isUp() {
  try {
    const r = await fetch(`${BASE}/api/plans`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isUp()) {
    touchIdle();
    return { started: false };
  }
  if (!child) {
    const args = MODE === "start" ? ["next", "start", "-p", String(PORT)] : ["next", "dev", "-p", String(PORT)];
    log(`보드 서버 시작: npx ${args.join(" ")} (cwd: ${APP_ROOT})`);
    child = spawn("npx", args, {
      cwd: APP_ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    });
    child.on("exit", (code) => {
      log(`보드 서버 종료 (exit ${code})`);
      child = null;
    });
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp()) {
      touchIdle();
      return { started: true };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("보드 서버가 120초 내에 응답하지 않습니다. 앱 루트에서 npm install이 되어 있는지 확인하세요.");
}

function stopServer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (child) {
    try { child.kill(); } catch { /* noop */ }
    child = null;
    return true;
  }
  return false;
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

async function api(pathname) {
  const r = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`API ${pathname} → ${r.status}`);
  return r.json();
}

function summarizePlan(plan) {
  const counts = {};
  for (const t of plan.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const openComments = plan.comments.filter((c) => !c.resolved);
  const lines = [
    `플랜: ${plan.title} (rev ${plan.revision})`,
    `보드: ${BASE}/plan/${plan.id}`,
    plan.generating ? `상태: 생성 중… (완료되면 태스크가 나타납니다)` : `태스크 ${plan.tasks.length}개: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "없음"}`,
  ];
  if (plan.generateError) lines.push(`생성 오류: ${plan.generateError}`);
  if (openComments.length > 0) {
    lines.push(`미반영 코멘트 ${openComments.length}건:`);
    for (const c of openComments) {
      const target = c.taskId ? plan.tasks.find((t) => t.id === c.taskId)?.title ?? "?" : "플랜 전체";
      lines.push(`  - [${target}] ${c.text}`);
    }
  }
  if (!plan.generating && plan.tasks.length > 0) {
    lines.push(`태스크 목록:`);
    for (const t of plan.tasks) lines.push(`  - [${t.status}] ${t.title}`);
  }
  return lines.join("\n");
}

const server = new McpServer({ name: "better-plan-mode", version: "0.2.0" });

server.tool(
  "board_open",
  "플랜 보드 웹서버를 (필요하면) 시작하고 접속 URL을 반환한다. 사용자가 계획표를 보고 싶어할 때 호출.",
  {},
  async () => {
    const { started } = await ensureServer();
    return text(`${started ? "보드 서버를 시작했습니다" : "보드 서버가 이미 실행 중입니다"}: ${BASE}\n사용자에게 이 URL을 열어보라고 안내하세요.`);
  }
);

server.tool(
  "plan_create",
  "목표(goal)로 새 실행 계획 생성을 시작하고 보드 URL을 즉시 반환한다. 생성은 백그라운드에서 수 분 걸릴 수 있으며 plan_status로 확인 가능. workdir 생략 시 현재 프로젝트 디렉토리를 대상으로 한다.",
  { goal: z.string().describe("달성할 목표 설명"), workdir: z.string().optional().describe("계획·실행 대상 프로젝트의 절대경로") },
  async ({ goal, workdir }) => {
    await ensureServer();
    const r = await fetch(`${BASE}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, workdir: workdir ?? process.cwd(), async: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `plan_create 실패 (${r.status})`);
    touchIdle();
    return text(
      `플랜 생성을 시작했습니다 (백그라운드, 수 분 소요될 수 있음).\n` +
      `보드: ${BASE}/plan/${data.id}\n` +
      `planId: ${data.id}\n` +
      `사용자에게 보드 URL을 안내하고, 필요하면 plan_status로 진행 상황을 확인하세요.`
    );
  }
);

server.tool(
  "plan_status",
  "플랜의 현재 상태(생성 중 여부, 태스크 상태, 미반영 코멘트)를 요약해 반환한다.",
  { planId: z.string().describe("플랜 id") },
  async ({ planId }) => {
    await ensureServer();
    const data = await api(`/api/plans/${encodeURIComponent(planId)}`);
    touchIdle();
    return text(summarizePlan(data.plan));
  }
);

server.tool(
  "plan_list",
  "저장된 플랜 목록을 반환한다.",
  {},
  async () => {
    await ensureServer();
    const plans = await api(`/api/plans`);
    touchIdle();
    if (plans.length === 0) return text("저장된 플랜이 없습니다.");
    return text(
      plans
        .map((p) => `- ${p.title} (rev ${p.revision}, ${p.doneCount}/${p.taskCount} 완료) — ${BASE}/plan/${p.id}`)
        .join("\n")
    );
  }
);

server.tool(
  "board_stop",
  "이 MCP가 시작한 플랜 보드 웹서버를 종료한다.",
  {},
  async () => {
    const killed = stopServer();
    return text(killed ? "보드 서버를 종료했습니다." : "이 MCP가 시작한 서버가 없습니다 (외부에서 띄운 서버는 건드리지 않음).");
  }
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopServer();
    process.exit(0);
  });
}
// 호스트가 stdio를 닫으면 함께 정리
process.stdin.on("close", () => {
  stopServer();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`MCP 준비 완료 (앱 루트: ${APP_ROOT}, 포트: ${PORT}, 모드: ${MODE})`);
