import { spawn } from "child_process";
import type { Plan, Run, RunLogLine, TaskStatus } from "./types";
import { getPlan, savePlan, newId } from "./store";
import { notifyRunComplete } from "./notify";

/**
 * 실행 중인 런의 인메모리 레지스트리.
 * next dev / next start 단일 프로세스 기준. (README 참고)
 */
const g = globalThis as unknown as { __runs?: Map<string, Run>; __planWrites?: Map<string, Promise<void>> };
const runs: Map<string, Run> = g.__runs ?? new Map();
g.__runs = runs;

/** 플랜별 쓰기 직렬화 큐 — 마커 파싱과 종료 처리가 같은 파일을 동시에 덮어쓰지 않게 한다. */
const planWrites: Map<string, Promise<void>> = g.__planWrites ?? new Map();
g.__planWrites = planWrites;

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

/**
 * 플랜 변경을 직렬 큐에 태운다. mutate가 true를 반환할 때만 저장한다.
 * stdout 스트림 핸들러(동기)에서도 안전하게 호출할 수 있다.
 */
function enqueuePlanUpdate(planId: string, mutate: (plan: Plan) => boolean): Promise<void> {
  const prev = planWrites.get(planId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const plan = await getPlan(planId);
      if (!plan) return;
      if (mutate(plan)) await savePlan(plan);
    })
    .catch((e) => {
      console.warn(`[runner] 플랜 갱신 실패: ${e instanceof Error ? e.message : e}`);
    });
  planWrites.set(planId, next);
  return next;
}

function buildPrompt(plan: Plan, taskIds: string[]): string {
  const selected = plan.tasks.filter((t) => taskIds.includes(t.id));
  const sections = selected
    .map(
      (t, i) => `### 작업 ${i + 1}: ${t.title}
- task_id: ${t.id}

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

## 진행 상황 보고 (필수)
보드가 실시간으로 진행률을 표시한다. 각 작업마다 아래 마커를 **그 자체로 한 줄에** 출력하라.

- 작업을 시작할 때: [[TASK_START:<task_id>]]
- 작업을 정상적으로 끝냈을 때: [[TASK_DONE:<task_id>]]
- 작업을 끝내지 못했을 때: [[TASK_FAILED:<task_id>]]

규칙:
- <task_id>는 위 작업 목록의 task_id를 그대로 쓴다. 제목이나 번호로 대체하지 않는다.
- 마커는 마지막에 몰아서 출력하지 말고, 해당 작업을 마치는 **즉시** 출력한다.
- 한 작업당 START 1회, DONE 또는 FAILED 1회.

## 완료 기준
- 작업을 위 순서대로 하나씩 수행한다.
- 마지막에 수행한 작업별 결과를 짧게 요약한다.
- 빌드/테스트가 가능하면 검증까지 수행한다.`;
}

const MARKER_RE = /\[\[TASK_(START|DONE|FAILED)\s*:\s*([^\]]+?)\s*\]\]/g;

/** 모델이 마커 형식을 설명하며 남기는 자리표시자 — 매칭 실패해도 경고하지 않는다. */
const PLACEHOLDER_REF_RE = /^(<.*>|task[_-]?id|id)$/i;

/** run별로 이미 경고한 미매칭 ref — 같은 경고를 로그에 반복하지 않는다. */
const unmatchedRefs = new Map<string, Set<string>>();

/** 로그에 남길 텍스트에서 마커를 걷어낸다 (사람이 읽는 로그는 깔끔하게). */
function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** run.taskIds 순서에서 아직 대기 중인 첫 태스크를 running으로 올린다 (진행 표시가 끊기지 않게). */
function promoteNextQueued(plan: Plan, run: Run) {
  const inRun = run.taskIds
    .map((id) => plan.tasks.find((t) => t.id === id))
    .filter((t): t is Plan["tasks"][number] => Boolean(t));
  if (inRun.some((t) => t.status === "running")) return;
  const next = inRun.find((t) => t.status === "queued");
  if (next) next.status = "running";
}

/**
 * assistant 텍스트에서 진행 마커를 뽑아 플랜 태스크 상태에 즉시 반영한다.
 * task_id 대신 제목으로 적어 오는 경우도 관대하게 매칭한다.
 */
function applyTaskMarkers(run: Run, text: string) {
  const hits: Array<{ kind: string; ref: string }> = [];
  for (const m of text.matchAll(MARKER_RE)) hits.push({ kind: m[1], ref: m[2] });
  if (hits.length === 0) return;

  let warnedRefs = unmatchedRefs.get(run.id);
  if (!warnedRefs) {
    warnedRefs = new Set();
    unmatchedRefs.set(run.id, warnedRefs);
  }

  void enqueuePlanUpdate(run.planId, (plan) => {
    let changed = false;
    for (const { kind, ref } of hits) {
      const task =
        plan.tasks.find((t) => t.id === ref && run.taskIds.includes(t.id)) ??
        plan.tasks.find(
          (t) => run.taskIds.includes(t.id) && t.title.trim().toLowerCase() === ref.trim().toLowerCase()
        );
      if (!task) {
        // 형식 설명용 자리표시자는 조용히 무시하고, 진짜 불일치만 한 번 알린다
        if (!PLACEHOLDER_REF_RE.test(ref) && !warnedRefs.has(ref)) {
          warnedRefs.add(ref);
          pushLog(run, "info", `진행 마커의 task_id를 찾지 못했습니다: ${ref.slice(0, 80)}`);
        }
        continue;
      }

      const nextStatus: TaskStatus = kind === "START" ? "running" : kind === "DONE" ? "done" : "failed";
      if (task.status === nextStatus) continue;
      // 이미 확정된 태스크를 START로 되돌리지 않는다
      if (kind === "START" && (task.status === "done" || task.status === "failed")) continue;

      task.status = nextStatus;
      changed = true;
      if (kind === "START") pushLog(run, "info", `시작: ${task.title}`);
      else if (kind === "DONE") pushLog(run, "info", `완료: ${task.title}`);
      else pushLog(run, "stderr", `실패: ${task.title}`);
    }
    if (changed) promoteNextQueued(plan, run);
    return changed;
  });
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
        const raw = block.text as string;
        applyTaskMarkers(run, raw);
        const clean = stripMarkers(raw);
        if (clean) pushLog(run, "assistant", clean);
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
    if (subtype === "success" && resultText) applyTaskMarkers(run, resultText);
    pushLog(run, "result", subtype === "success" ? stripMarkers(resultText ?? "") || "완료" : `실패: ${subtype}`);
    return;
  }
}

export interface StartRunOptions {
  planId: string;
  taskIds: string[];
  /** true면 --dangerously-skip-permissions (기본 acceptEdits) */
  skipPermissions?: boolean;
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

  // 첫 태스크만 running, 나머지는 queued — 마커가 도착하면 하나씩 넘어간다.
  for (const t of plan.tasks) {
    if (!taskIds.includes(t.id)) continue;
    t.status = t.id === taskIds[0] ? "running" : "queued";
  }
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

  const port = opts.port ?? 3000;

  child.on("error", async (err) => {
    pushLog(run, "stderr", `claude CLI 실행 실패: ${err.message} — claude가 PATH에 있는지 확인하세요.`);
    run.status = "failed";
    run.endedAt = new Date().toISOString();
    const updated = await finalizeTasks(run, false);
    if (updated) void notifyRunComplete(updated, run, port);
  });

  child.on("close", async (code) => {
    if (run.status === "failed") return; // error 핸들러가 이미 처리
    const ok = code === 0;
    run.status = ok ? "succeeded" : "failed";
    run.endedAt = new Date().toISOString();
    pushLog(run, "info", `프로세스 종료 (exit ${code})`);
    const updated = await finalizeTasks(run, ok);
    if (updated) void notifyRunComplete(updated, run, port);
  });

  return run;
}

/**
 * 종료 시 정리. 마커로 이미 done/failed가 된 태스크는 그대로 두고,
 * 아직 running/queued로 남은 것만 프로세스 종료 코드로 확정한다.
 */
async function finalizeTasks(run: Run, ok: boolean): Promise<Plan | null> {
  await enqueuePlanUpdate(run.planId, (plan) => {
    let changed = false;
    for (const t of plan.tasks) {
      if (!run.taskIds.includes(t.id)) continue;
      if (t.status !== "running" && t.status !== "queued") continue;
      t.status = ok ? "done" : "failed";
      changed = true;
    }
    return changed;
  });
  unmatchedRefs.delete(run.id);
  return getPlan(run.planId);
}
