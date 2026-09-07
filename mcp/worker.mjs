#!/usr/bin/env node
/**
 * Better Plan Mode — 원격 워커 MCP 서버 (Streamable HTTP)
 *
 * 이 PC를 "서브 PC"로 쓰기 위한 진입점. 다른 PC의 Claude Code가 HTTP MCP로 붙어
 * 잡을 제출하고(job_submit), 진행을 확인하고(job_status / job_logs), 화면을 보고(worker_screenshot),
 * 취소(job_cancel)하고, 남은 worktree를 정리(worker_cleanup)한다. 실제 실행은 보드 서버(next)의 /api/jobs가 맡는다 — 이 프로세스는 얇은 프록시다.
 *
 * 메인 PC 등록 예:
 *   claude mcp add --transport http mac-worker http://macmini-macmini:4000/mcp \
 *     --header "Authorization: Bearer <WORKER_TOKEN>" -s user
 *
 * 환경변수 (.env.local / .env 자동 로드):
 *   WORKER_TOKEN            필수. Bearer 토큰. 없으면 기동 거부.
 *   WORKER_PORT             기본 4000
 *   WORKER_BIND             기본 0.0.0.0 (Tailscale IP로 좁혀도 됨)
 *   WORKER_BOARD_URL        원격 에이전트에게 알려줄 보드 주소. 기본: 요청 Host의 호스트명 + PLANMODE_PORT
 *   WORKER_SPAWN_BOARD      "0"이면 보드 서버를 직접 띄우지 않음 (launchd로 따로 띄울 때)
 *   PLANMODE_PORT           보드 포트, 기본 3000
 *   PLANMODE_MODE           "dev" | "start"(기본 — 사전 npm run build 필요)
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// .env 로드 (dotenv 없이 — KEY=VALUE 줄만, 이미 있는 env는 덮지 않음)
// ---------------------------------------------------------------------------
for (const name of [".env.local", ".env"]) {
  try {
    const raw = await fs.readFile(path.join(APP_ROOT, name), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* 없으면 통과 */
  }
}

const TOKEN = process.env.WORKER_TOKEN ?? "";
const PORT = Number(process.env.WORKER_PORT || 4000);
const BIND = process.env.WORKER_BIND || "0.0.0.0";
const BOARD_PORT = Number(process.env.PLANMODE_PORT || 3000);
const BOARD_LOCAL = `http://127.0.0.1:${BOARD_PORT}`;
const BOARD_MODE = process.env.PLANMODE_MODE === "dev" ? "dev" : "start";
const SPAWN_BOARD = process.env.WORKER_SPAWN_BOARD !== "0";

function log(msg) {
  process.stderr.write(`[worker-mcp] ${msg}\n`);
}

if (!TOKEN || TOKEN.length < 16) {
  log("WORKER_TOKEN이 없거나 너무 짧습니다 (16자 이상). .env.local에 설정하세요. 생성 예: openssl rand -hex 24");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 보드 서버 보장
// ---------------------------------------------------------------------------
let boardChild = null;

async function boardUp() {
  try {
    const r = await fetch(`${BOARD_LOCAL}/api/jobs`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureBoard() {
  if (await boardUp()) return;
  if (!SPAWN_BOARD) throw new Error(`보드 서버(${BOARD_LOCAL})가 응답하지 않습니다. launchd 보드 서비스 상태를 확인하세요.`);
  if (!boardChild) {
    const args = BOARD_MODE === "start" ? ["next", "start", "-p", String(BOARD_PORT)] : ["next", "dev", "-p", String(BOARD_PORT)];
    log(`보드 서버 시작: npx ${args.join(" ")}`);
    boardChild = spawn("npx", args, {
      cwd: APP_ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    });
    boardChild.on("exit", (code) => {
      log(`보드 서버 종료 (exit ${code})`);
      boardChild = null;
    });
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await boardUp()) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("보드 서버가 120초 내에 응답하지 않습니다. npm install / npm run build 상태를 확인하세요.");
}

// ---------------------------------------------------------------------------
// 보드 API 호출
// ---------------------------------------------------------------------------
async function api(pathname, init = {}) {
  await ensureBoard();
  const r = await fetch(`${BOARD_LOCAL}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `API ${pathname} → ${r.status}`);
  return data;
}

/** 원격 에이전트에게 보여줄 보드 주소 — 요청이 들어온 Host 기준 (Tailscale 이름/IP 그대로) */
function boardUrlFor(req) {
  if (process.env.WORKER_BOARD_URL) return process.env.WORKER_BOARD_URL.replace(/\/$/, "");
  const host = (req?.headers?.host ?? "localhost").replace(/:\d+$/, "");
  return `http://${host}:${BOARD_PORT}`;
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function ago(iso) {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분 전`;
}

function fmtJob(j, boardUrl) {
  const lines = [
    `job ${j.id}`,
    `제목: ${j.title}`,
    `프로젝트: ${j.project} · 모드: ${j.mode} · 브랜치: ${j.branch ?? "-"}` +
      `${j.model ? ` · 모델: ${j.model}` : ""}${j.effort ? ` · effort: ${j.effort}` : ""}`,
    `상태: ${j.status} (단계: ${j.stage})${j.status === "running" ? ` · 마지막 활동: ${ago(j.lastActivityAt)}` : ""}`,
  ];
  if (j.verify) lines.push(`Unity 검증: ${j.verify}`);
  if (j.commitCount !== undefined) lines.push(`커밋: ${j.commitCount}`);
  if (j.prUrl) lines.push(`PR: ${j.prUrl}`);
  if (j.error) lines.push(`오류: ${j.error}`);
  lines.push(`보드: ${boardUrl}/jobs/${j.id}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP 서버 (요청마다 새 인스턴스 — stateless)
// ---------------------------------------------------------------------------
function createServer(req) {
  const boardUrl = boardUrlFor(req);
  const server = new McpServer({ name: "better-plan-worker", version: "0.1.0" });

  server.registerTool(
    "worker_projects",
    { description: "이 워커 PC에 등록된 프로젝트 키 목록을 반환한다. job_submit 전에 확인." },
    async () => {
      const data = await api("/api/jobs");
      const projects = data.projects ?? [];
      if (projects.length === 0) return text("등록된 프로젝트가 없습니다 (config/projects.json)");
      const lines = projects.map(
        (p) =>
          `- ${p.key}  (base: ${p.baseBranch}, direct: ${p.allowDirect ? "허용" : "잠김"}, Unity 검증: ${p.unityVerify ? "켜짐" : "없음"}` +
          `${p.defaultModel ? `, 기본 모델: ${p.defaultModel}` : ""}${p.defaultEffort ? `, 기본 effort: ${p.defaultEffort}` : ""})`
      );
      return text(`등록된 프로젝트:\n${lines.join("\n")}\n\neffort 선택지: ${(data.efforts ?? []).join(" | ")}`);
    }
  );

  server.registerTool(
    "job_submit",
    {
      description:
        "워커 PC에 작업을 제출한다. 즉시 jobId를 반환하고 백그라운드에서 worktree → claude -p → 커밋 → push → (Unity 검증) → PR 순으로 실행된다. " +
        "완료는 job_status로 폴링하거나 Slack/Discord 웹훅으로 통지된다. mode=pr(기본)은 전용 브랜치+PR, mode=direct는 기본 브랜치에 바로 push. " +
        "model/effort로 워커 세션의 모델·추론 레벨을 고를 수 있다 (생략 시 프로젝트 기본값 → 워커 PC 기본값).",
      inputSchema: {
        project: z.string().describe("worker_projects가 돌려준 프로젝트 키"),
        prompt: z.string().describe("워커 세션(claude -p)에 줄 지시문. 구체적일수록 좋다."),
        title: z.string().optional().describe("짧은 제목 — 커밋/PR/알림에 쓰임. 생략 시 prompt 첫 줄"),
        mode: z.enum(["pr", "direct"]).optional().describe("pr(기본): 브랜치 push + PR | direct: 기본 브랜치에 직접 push"),
        model: z.string().optional().describe("claude --model 값. alias(sonnet, opus, haiku, fable) 또는 전체 이름"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("claude --effort 추론 레벨"),
        maxTurns: z.number().int().min(1).max(1000).optional().describe("claude --max-turns 상한"),
        skipPermissions: z.boolean().optional().describe("true면 --dangerously-skip-permissions (기본 acceptEdits + git 커밋 허용)"),
      },
    },
    async ({ project, prompt, title, mode, model, effort, maxTurns, skipPermissions }) => {
      const data = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ project, prompt, title, mode, model, effort, maxTurns, skipPermissions }),
      });
      return text(
        `잡을 제출했습니다.\njobId: ${data.id}\n브랜치: ${data.branch ?? "(실행 시 배정)"}\n보드: ${boardUrl}/jobs/${data.id}\n` +
          `사용자에게 보드 URL을 안내하고, 진행 확인은 job_status(jobId)로 하세요. 완료 시 웹훅 알림이 갑니다.`
      );
    }
  );

  server.registerTool(
    "job_resume",
    {
      description:
        "실패·취소·중단된 잡을 worktree 그대로 두고 커밋 단계부터 이어서 마무리한다(push → 검증 → PR). claude 세션은 다시 돌리지 않는다. " +
        "Unity 검증이 시간 초과·실패로 막혔으면 skipVerify=true로 검증 없이 마무리할 수 있다.",
      inputSchema: {
        jobId: z.string(),
        skipVerify: z.boolean().optional().describe("true면 Unity 검증 생략"),
      },
    },
    async ({ jobId, skipVerify }) => {
      const data = await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
        method: "POST",
        body: JSON.stringify({ skipVerify }),
      });
      return text(`재개 요청 완료 (${data.resumeCount}회째): ${data.id} → ${data.status}\n보드: ${boardUrl}/jobs/${data.id}\n진행은 job_status로 확인하세요.`);
    }
  );

  server.registerTool(
    "job_status",
    {
      description: "잡의 현재 상태·단계·PR 링크·오류와 최근 로그 몇 줄을 요약해 반환한다.",
      inputSchema: { jobId: z.string().describe("job_submit이 돌려준 jobId") },
    },
    async ({ jobId }) => {
      const meta = await api(`/api/jobs/${encodeURIComponent(jobId)}?since=1000000000`);
      const tailFrom = Math.max(0, (meta.logLength ?? 0) - 8);
      const tail = await api(`/api/jobs/${encodeURIComponent(jobId)}?since=${tailFrom}`);
      const lines = (tail.log ?? []).map((l) => `[${l.kind}] ${l.text.slice(0, 300)}`);
      return text(`${fmtJob(meta, boardUrl)}\n\n최근 로그 (${tailFrom}..${meta.logLength}):\n${lines.join("\n") || "(없음)"}`);
    }
  );

  server.registerTool(
    "job_logs",
    {
      description: "잡 로그를 since 커서부터 limit 줄 반환한다. 반환된 nextSince를 다음 호출에 넘겨 증분 조회.",
      inputSchema: {
        jobId: z.string(),
        since: z.number().int().min(0).optional().describe("로그 커서 (기본 0)"),
        limit: z.number().int().min(1).max(500).optional().describe("최대 줄 수 (기본 100)"),
      },
    },
    async ({ jobId, since = 0, limit = 100 }) => {
      const data = await api(`/api/jobs/${encodeURIComponent(jobId)}?since=${since}`);
      const slice = (data.log ?? []).slice(0, limit);
      const nextSince = since + slice.length;
      const lines = slice.map((l) => `[${l.kind}] ${l.text.slice(0, 1200)}`);
      return text(
        `status: ${data.status} · stage: ${data.stage} · logLength: ${data.logLength} · nextSince: ${nextSince}\n\n${lines.join("\n") || "(새 로그 없음)"}`
      );
    }
  );

  server.registerTool(
    "job_list",
    {
      description: "최근 잡 목록 (최신순).",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit = 10 }) => {
      const data = await api("/api/jobs");
      const jobs = (data.jobs ?? []).slice(0, limit);
      if (jobs.length === 0) return text("잡이 없습니다.");
      return text(
        jobs
          .map((j) => `- ${j.status.padEnd(9)} ${j.id.slice(0, 8)}  ${j.project}/${j.mode}  ${j.title}${j.prUrl ? `  ${j.prUrl}` : ""}`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "job_cancel",
    {
      description: "대기 중이거나 실행 중인 잡을 취소한다. 실행 중이면 claude/git 프로세스를 종료하고 worktree는 남긴다.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      const data = await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      return text(`취소 요청 완료: ${data.id} → ${data.status} (단계: ${data.stage})`);
    }
  );

  server.registerTool(
    "worker_cleanup",
    {
      description:
        "워커 PC에 남은 worktree·브랜치 잔여물을 정리한다. 평소에는 서버가 보관 기한(기본 48시간, 저장 안 된 변경이 남았으면 168시간)에 " +
        "맞춰 자동으로 치우므로 보통 부를 필요가 없다. 용량이 급하거나 현황을 알고 싶을 때만 쓴다. " +
        "dryRun=true면 지우지 않고 목록만 보여 준다. force=true는 보관 기한을 무시한다(실행 중인 잡과 저장 안 된 변경은 그래도 남긴다).",
      inputSchema: {
        dryRun: z.boolean().optional().describe("true면 대상만 조회하고 지우지 않는다"),
        force: z.boolean().optional().describe("보관 기한 무시"),
        includeUnsaved: z.boolean().optional().describe("force와 함께 쓰면 커밋·push 안 된 변경이 남은 worktree까지 삭제"),
      },
    },
    async ({ dryRun = false, force = false, includeUnsaved = false }) => {
      const r = dryRun
        ? (await api("/api/worktrees?size=1", { timeoutMs: 180_000 })).scan
        : await api("/api/worktrees", {
            method: "POST",
            body: JSON.stringify({ force, includeUnsaved, measure: true }),
            timeoutMs: 300_000,
          });
      const size = (kb) => (!kb ? "-" : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}GB` : kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`);
      const removed = r.worktrees.filter((w) => w.action === "removed");
      const kept = r.worktrees.filter((w) => w.action === "kept");
      const lines = [
        `${dryRun ? "정리 예정" : "정리함"}: worktree ${removed.length}개${r.freedKb ? ` (${size(r.freedKb)})` : ""}`,
        ...removed.map((w) => `  - ${w.path}${w.sizeKb ? ` ${size(w.sizeKb)}` : ""} — ${w.reason}`),
        `남김: ${kept.length}개`,
        ...kept.map((w) => `  - ${w.path} — ${w.reason}`),
      ];
      if (r.removedLocalBranches?.length) lines.push(`로컬 브랜치 삭제: ${r.removedLocalBranches.join(", ")}`);
      if (r.removedRemoteBranches?.length) lines.push(`원격 브랜치 삭제: ${r.removedRemoteBranches.join(", ")}`);
      if (r.errors?.length) lines.push(`오류: ${r.errors.join(" / ")}`);
      lines.push(`보관 기한 ${r.ttlHours}시간 · 저장 안 된 변경 ${r.unsavedTtlHours}시간 · 루트 ${r.worktreeRoot}`);
      return text(lines.join("\n"));
    }
  );

  server.registerTool(
    "worker_screenshot",
    {
      description:
        "워커 PC의 현재 화면을 캡처해 이미지로 반환한다 (Unity 에디터 상태 등 확인용). GUI 세션·화면 기록 권한이 필요하다.",
    },
    async () => {
      const shot = await api("/api/screenshots", { method: "POST", timeoutMs: 30_000 });
      const r = await fetch(`${BOARD_LOCAL}${shot.url}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`스크린샷 파일을 읽지 못했습니다 (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        content: [
          { type: "text", text: `화면 캡처 (${Math.round(buf.length / 1024)}KB): ${boardUrl}${shot.url}` },
          { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function authorized(req) {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, board: await boardUp() }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }

  if (!authorized(req)) {
    log(`인증 실패: ${req.socket.remoteAddress}`);
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  try {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const server = createServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log(`요청 처리 오류: ${e instanceof Error ? e.message : e}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  }
});

httpServer.listen(PORT, BIND, () => {
  log(`워커 MCP 대기 중: http://${BIND}:${PORT}/mcp (보드: ${BOARD_LOCAL}, spawn: ${SPAWN_BOARD})`);
  if (SPAWN_BOARD) {
    ensureBoard().catch((e) => log(`보드 서버 사전 기동 실패: ${e.message}`));
  }
});

function shutdown() {
  log("종료 중…");
  httpServer.close();
  if (boardChild) {
    try {
      boardChild.kill();
    } catch {
      /* noop */
    }
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
