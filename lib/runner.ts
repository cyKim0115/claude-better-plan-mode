import { spawn } from "child_process";
import type { Plan, Run, RunLogLine } from "./types";
import { getPlan, savePlan, newId } from "./store";

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

function buildPrompt(plan: Plan, taskIds: string[]): string {
  const selected = plan.tasks.filter((t) => taskIds.includes(t.id));
  const sections = selected
    .map(
      (t, i) => `### 작업 ${i + 1}: ${t.title}
${t.description}

지시사항:
${t.prompt}
${t.files.length ? `\n관련 파일 힌트: ${t.files.join(", ")}` : ""}`
    )
    .join("\n\n");

  return `다음은 더 큰 실행 계획("${plan.title}")의 일부다. 아래 선택된 작업들만 수행하라. 계획의 다른 작업은 건드리지 말 것.

## 전체 계획 개요 (컨텍스트용)
${plan.overview}

## 이번에 수행할 작업들
${sections}

## 완료 기준
- 각 작업을 순서대로 수행하고, 마지막에 수행한 작업별 결과를 짧게 요약하라.
- 빌드/테스트가 가능하면 검증까지 수행하라.`;
}

/** stream-json 한 줄을 사람이 읽을 로그로 변환 */
function formatStreamEvent(run: Run, obj: Record<string, unknown>) {
  const type = obj.type as string;
  if (type === "system") {
    const subtype = obj.subtype as string;
    if (subtype === "init") pushLog(run, "system", `세션 시작 (model: ${(obj as { model?: string }).model ?? "?"})`);
    return;
  }
  if (type === "assistant") {
    const message = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        pushLog(run, "assistant", block.text as string);
      } else if (block.type === "tool_use") {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const hint =
          (input?.file_path as string) ??
          (input?.path as string) ??
          (input?.command as string) ??
          (input?.pattern as string) ??
          "";
        pushLog(run, "tool", `${name} ${typeof hint === "string" ? hint.slice(0, 200) : ""}`.trim());
      }
    }
    return;
  }
  if (type === "result") {
    const subtype = obj.subtype as string;
    const resultText = (obj as { result?: string }).result;
    pushLog(run, "result", subtype === "success" ? resultText ?? "완료" : `실패: ${subtype}`);
    return;
  }
}

export interface StartRunOptions {
  planId: string;
  taskIds: string[];
  /** true면 --dangerously-skip-permissions (기본 acceptEdits) */
  skipPermissions?: boolean;
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

  // 선택된 태스크를 running으로
  for (const t of plan.tasks) if (taskIds.includes(t.id)) t.status = "running";
  await savePlan(plan);

  const prompt = buildPrompt(plan, taskIds);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    opts.skipPermissions ? "--dangerously-skip-permissions" : "--permission-mode",
  ];
  if (!opts.skipPermissions) args.push("acceptEdits");

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

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        formatStreamEvent(run, JSON.parse(line));
      } catch {
        pushLog(run, "info", line.slice(0, 500));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) pushLog(run, "stderr", text.slice(0, 1000));
  });

  child.on("error", async (err) => {
    pushLog(run, "stderr", `claude CLI 실행 실패: ${err.message} — claude가 PATH에 있는지 확인하세요.`);
    run.status = "failed";
    run.endedAt = new Date().toISOString();
    await finalizeTasks(run, false);
  });

  child.on("close", async (code) => {
    if (run.status === "failed") return; // error 핸들러가 이미 처리
    const ok = code === 0;
    run.status = ok ? "succeeded" : "failed";
    run.endedAt = new Date().toISOString();
    pushLog(run, "info", `프로세스 종료 (exit ${code})`);
    await finalizeTasks(run, ok);
  });

  return run;
}

async function finalizeTasks(run: Run, ok: boolean) {
  const plan = await getPlan(run.planId);
  if (!plan) return;
  for (const t of plan.tasks) {
    if (run.taskIds.includes(t.id) && t.status === "running") {
      t.status = ok ? "done" : "failed";
    }
  }
  await savePlan(plan);
}
