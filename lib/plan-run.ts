// 플랜 착수 공용 로직 — 실행 지시문 조립과 진행 마커 반영.
//
// 두 실행 경로가 이 모듈을 공유한다:
// - lib/jobs.ts   프로젝트가 지정된 플랜: worktree → claude → 커밋 → push/PR
// - lib/runner.ts 경로만 있는 레거시 플랜: workdir에서 claude만
//
// 플랜 파일 쓰기는 반드시 여기의 직렬 큐를 거친다 (마커 반영과 종료 처리가 같은 파일을 덮어쓰지 않게).

import type { Plan, PlanTask, RunLogLine, TaskStatus } from "./types";
import { getPlan, savePlan } from "./store";

/** 플랜별 쓰기 직렬화 큐 */
const g = globalThis as unknown as { __planWrites?: Map<string, Promise<void>> };
const planWrites: Map<string, Promise<void>> = g.__planWrites ?? new Map();
g.__planWrites = planWrites;

/**
 * 플랜 변경을 직렬 큐에 태운다. mutate가 true를 반환할 때만 저장한다.
 * stdout 스트림 핸들러(동기)에서도 안전하게 호출할 수 있다.
 */
export function enqueuePlanUpdate(planId: string, mutate: (plan: Plan) => boolean): Promise<void> {
  const prev = planWrites.get(planId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const plan = await getPlan(planId);
      if (!plan) return;
      if (mutate(plan)) await savePlan(plan);
    })
    .catch((e) => {
      console.warn(`[plan-run] 플랜 갱신 실패: ${e instanceof Error ? e.message : e}`);
    });
  planWrites.set(planId, next);
  return next;
}

// ---------------------------------------------------------------------------
// 지시문
// ---------------------------------------------------------------------------

/** 착수 방식 — worktree는 잡 파이프라인(커밋까지), local은 레거시 workdir 실행 */
export type PlanRunKind = "worktree" | "local";

export interface PlanPromptContext {
  kind: PlanRunKind;
  /** worktree 실행일 때만 */
  project?: string;
  worktree?: string;
  branch?: string;
  baseBranch?: string;
  /** pr | direct */
  mode?: string;
}

/**
 * 선택된 태스크만 수행하도록 지시문을 만든다.
 * "선택된 작업만 수행" 경계는 부분 착수의 핵심 계약이다 — 문구를 약화시키지 않는다.
 */
export function buildPlanPrompt(plan: Plan, taskIds: string[], ctx: PlanPromptContext): string {
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

  const env =
    ctx.kind === "worktree"
      ? `## 실행 환경
- 프로젝트: ${ctx.project}
- 작업 디렉터리(worktree): ${ctx.worktree}
- 현재 브랜치: ${ctx.branch} (기준: ${ctx.baseBranch})
- 결과 처리 모드: ${ctx.mode === "direct" ? `${ctx.baseBranch}에 직접 반영` : "PR 생성"}

`
      : "";

  const finish =
    ctx.kind === "worktree"
      ? `## 마무리 규칙 (필수)
- 작업이 끝나면 변경 사항을 커밋한다. 커밋 메시지는 이 프로젝트의 CLAUDE.md 커밋 규칙을 따른다.
  git add / git commit은 승인 없이 실행할 수 있다. 커밋이 막히면 변경을 워킹트리에 남겨 두어라 — 워커가 대신 커밋한다.
- **push 하지 않는다.** push·PR 생성은 워커가 처리한다.
- 브랜치를 바꾸거나 worktree 밖의 경로를 수정하지 않는다.
- 마지막에 수행한 작업별 결과를 짧게 요약한다.
- 빌드/테스트가 가능하면 검증까지 수행한다.`
      : `## 완료 기준
- 작업을 위 순서대로 하나씩 수행한다.
- 마지막에 수행한 작업별 결과를 짧게 요약한다.
- 빌드/테스트가 가능하면 검증까지 수행한다.`;

  return `다음은 더 큰 실행 계획("${plan.title}")의 일부다. 아래 선택된 작업들만 수행하라. 계획의 다른 작업은 건드리지 말 것.

${env}## 전체 계획 개요 (컨텍스트용)
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

${finish}`;
}

// ---------------------------------------------------------------------------
// 진행 마커
// ---------------------------------------------------------------------------

const MARKER_RE = /\[\[TASK_(START|DONE|FAILED)\s*:\s*([^\]]+?)\s*\]\]/g;

/** 모델이 마커 형식을 설명하며 남기는 자리표시자 — 매칭 실패해도 경고하지 않는다. */
const PLACEHOLDER_REF_RE = /^(<.*>|task[_-]?id|id)$/i;

/** 로그에 남길 텍스트에서 마커를 걷어낸다 (사람이 읽는 로그는 깔끔하게). */
export function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** taskIds 순서에서 아직 대기 중인 첫 태스크를 running으로 올린다 (진행 표시가 끊기지 않게). */
function promoteNextQueued(plan: Plan, taskIds: string[]) {
  const inScope = taskIds
    .map((id) => plan.tasks.find((t) => t.id === id))
    .filter((t): t is PlanTask => Boolean(t));
  if (inScope.some((t) => t.status === "running")) return;
  const next = inScope.find((t) => t.status === "queued");
  if (next) next.status = "running";
}

export interface PlanProgress {
  /** assistant/result 텍스트에서 마커를 뽑아 태스크 상태에 반영 */
  apply(text: string): void;
  /** 종료 시 아직 running/queued인 태스크를 프로세스 결과로 확정하고 최신 플랜을 돌려준다 */
  finalize(ok: boolean): Promise<Plan | null>;
}

/**
 * 실행 한 건(run 또는 job)의 진행 마커 반영기.
 * task_id 대신 제목으로 적어 오는 경우도 관대하게 매칭한다.
 */
export function createPlanProgress(
  planId: string,
  taskIds: string[],
  log: (kind: RunLogLine["kind"], text: string) => void
): PlanProgress {
  const warnedRefs = new Set<string>();

  return {
    apply(text: string) {
      const hits: Array<{ kind: string; ref: string }> = [];
      for (const m of text.matchAll(MARKER_RE)) hits.push({ kind: m[1], ref: m[2] });
      if (hits.length === 0) return;

      void enqueuePlanUpdate(planId, (plan) => {
        let changed = false;
        for (const { kind, ref } of hits) {
          const task =
            plan.tasks.find((t) => t.id === ref && taskIds.includes(t.id)) ??
            plan.tasks.find(
              (t) => taskIds.includes(t.id) && t.title.trim().toLowerCase() === ref.trim().toLowerCase()
            );
          if (!task) {
            // 형식 설명용 자리표시자는 조용히 무시하고, 진짜 불일치만 한 번 알린다
            if (!PLACEHOLDER_REF_RE.test(ref) && !warnedRefs.has(ref)) {
              warnedRefs.add(ref);
              log("info", `진행 마커의 task_id를 찾지 못했습니다: ${ref.slice(0, 80)}`);
            }
            continue;
          }

          const nextStatus: TaskStatus = kind === "START" ? "running" : kind === "DONE" ? "done" : "failed";
          if (task.status === nextStatus) continue;
          // 이미 확정된 태스크를 START로 되돌리지 않는다
          if (kind === "START" && (task.status === "done" || task.status === "failed")) continue;

          task.status = nextStatus;
          changed = true;
          if (kind === "START") log("info", `시작: ${task.title}`);
          else if (kind === "DONE") log("info", `완료: ${task.title}`);
          else log("stderr", `실패: ${task.title}`);
        }
        if (changed) promoteNextQueued(plan, taskIds);
        return changed;
      });
    },

    async finalize(ok: boolean) {
      await enqueuePlanUpdate(planId, (plan) => {
        let changed = false;
        for (const t of plan.tasks) {
          if (!taskIds.includes(t.id)) continue;
          if (t.status !== "running" && t.status !== "queued") continue;
          t.status = ok ? "done" : "failed";
          changed = true;
        }
        return changed;
      });
      return getPlan(planId);
    },
  };
}

/** 착수 직후 상태 — 첫 태스크만 running, 나머지는 queued. 마커가 도착하면 하나씩 넘어간다. */
export async function beginPlanTasks(planId: string, taskIds: string[]): Promise<void> {
  await enqueuePlanUpdate(planId, (plan) => {
    for (const t of plan.tasks) {
      if (!taskIds.includes(t.id)) continue;
      t.status = t.id === taskIds[0] ? "running" : "queued";
    }
    return true;
  });
}
