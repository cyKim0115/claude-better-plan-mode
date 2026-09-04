// 레거시 착수 경로 — 프로젝트(config/projects.json)가 지정되지 않은 플랜을 workdir에서 그대로 돌린다.
// git 처리(worktree·커밋·push/PR)가 필요한 플랜은 lib/jobs.ts의 잡 파이프라인을 탄다.

import { spawn } from "child_process";
import type { JobEffort, Plan, Run, RunLogLine } from "./types";
import { getPlan, newId } from "./store";
import { notifyRunComplete } from "./notify";
import { createLineParser } from "./stream-json";
import { beginPlanTasks, buildPlanPrompt, createPlanProgress, stripMarkers } from "./plan-run";

/**
 * 실행 중인 런의 인메모리 레지스트리.
 * next dev / next start 단일 프로세스 기준. (README 참고)
 */
const g = globalThis as unknown as { __runs?: Map<string, Run> };
const runs: Map<string, Run> = g.__runs ?? new Map();
g.__runs = runs;

export function getRun(id: string): Run | null {
  return runs.get(id) ?? null;
}

export function listRunsForPlan(planId: string): Run[] {
  return [...runs.values()]
    .filter((r) => r.planId === planId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function pushLog(run: Run, kind: RunLogLine["kind"], text: string) {
  run.log.push({ ts: new Date().toISOString(), kind, text });
  if (run.log.length > 5000) run.log.splice(0, run.log.length - 5000);
}

export interface StartRunOptions {
  planId: string;
  taskIds: string[];
  /** true면 --dangerously-skip-permissions (기본 acceptEdits) */
  skipPermissions?: boolean;
  /** claude --model (생략 시 CLI 기본) */
  model?: string;
  /** claude --effort */
  effort?: JobEffort;
  /** claude --max-turns */
  maxTurns?: number;
  /** 완료 웹훅 링크 생성에 쓸 웹 서버 포트 (기본 3000) */
  port?: number;
}

export async function startRun(opts: StartRunOptions): Promise<Run> {
  const plan = await getPlan(opts.planId);
  if (!plan) throw new Error("plan not found");
  const taskIds = opts.taskIds.filter((id) => plan.tasks.some((t) => t.id === id));
  if (taskIds.length === 0) throw new Error("no valid tasks selected");
  if (!plan.workdir || !plan.workdir.trim()) throw new Error("plan.workdir가 비어 있음 — 실행할 프로젝트 경로가 필요");

  const run: Run = {
    id: newId(),
    planId: plan.id,
    taskIds,
    status: "starting",
    startedAt: new Date().toISOString(),
    log: [],
  };
  runs.set(run.id, run);

  await beginPlanTasks(plan.id, taskIds);

  const progress = createPlanProgress(plan.id, taskIds, (kind, text) => pushLog(run, kind, text));
  const prompt = buildPlanPrompt(plan, taskIds, { kind: "local" });

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    opts.skipPermissions ? "--dangerously-skip-permissions" : "--permission-mode",
  ];
  if (!opts.skipPermissions) args.push("acceptEdits");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));

  pushLog(run, "info", `claude ${args.join(" ")}  (cwd: ${plan.workdir})`);

  // 프롬프트는 stdin으로 전달 (플랫폼별 인용부호 문제 회피)
  const child = spawn("claude", args, {
    cwd: plan.workdir,
    shell: process.platform === "win32", // Windows에서 claude.cmd 해석
    env: process.env,
  });
  run.status = "running";

  child.stdin.write(prompt);
  child.stdin.end();

  const parser = createLineParser((ev) => {
    if (ev.kind === "assistant" || ev.kind === "result") {
      progress.apply(ev.text);
      const clean = stripMarkers(ev.text) || (ev.kind === "result" ? "완료" : "");
      if (clean) pushLog(run, ev.kind, clean);
      return;
    }
    pushLog(run, ev.kind, ev.text);
  });

  child.stdout.on("data", (chunk: Buffer) => parser.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) pushLog(run, "stderr", text.slice(0, 1000));
  });

  const port = opts.port ?? 3000;

  const settle = async (ok: boolean) => {
    parser.flush();
    run.status = ok ? "succeeded" : "failed";
    run.endedAt = new Date().toISOString();
    const updated: Plan | null = await progress.finalize(ok);
    if (updated) void notifyRunComplete(updated, run, port);
  };

  child.on("error", async (err) => {
    pushLog(run, "stderr", `claude CLI 실행 실패: ${err.message} — claude가 PATH에 있는지 확인하세요.`);
    await settle(false);
  });

  child.on("close", async (code) => {
    if (run.status === "failed") return; // error 핸들러가 이미 처리
    pushLog(run, "info", `프로세스 종료 (exit ${code})`);
    await settle(code === 0);
  });

  return run;
}
