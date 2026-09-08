// 원격 워커 잡 — 다른 PC의 에이전트가 worker MCP로 제출한 작업을
// 프로젝트별 직렬 큐에 태워 worktree → claude -p → 커밋 → push → (Unity 검증) → PR → 정리 순으로 돌린다.
//
// 설계 원칙 (원격이라 "반드시 끝나거나, 왜 못 끝났는지 남아야" 한다):
// - pr 모드는 커밋 직후 브랜치를 먼저 push한다. 검증이 걸리거나 죽어도 작업물은 원격에 남는다.
// - 모든 외부 프로세스에 워치독(전체 타임아웃 + 무출력 정지 감지)이 붙는다. 조용히 멈춘 잡은 없다.
// - 실패·취소·정지한 잡은 worktree를 남기고, job_resume으로 커밋 단계부터 이어서 마무리할 수 있다.
// - 잡 메타·로그는 data/jobs/<id>.json에 저장. 실행 중 프로세스 핸들은 인메모리(globalThis) — 단일 서버 프로세스 전제.
// - 셸 문자열 보간으로 명령을 만들지 않는다. 잡 내용(제목·프롬프트)은 신뢰 입력이 아니다.

import { type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { JOB_EFFORTS, type Job, type JobEffort, type JobMode, type JobStage, type ProjectConfig, type RunLogLine } from "./types";
import { getPlan, newId } from "./store";
import { notifyJobFinished, notifyWorktreeGc } from "./notify";
import { createLineParser } from "./stream-json";
import { beginPlanTasks, buildPlanPrompt, createPlanProgress, stripMarkers, type PlanProgress } from "./plan-run";
import { killTree, spawnWatched, type ProcResult } from "./proc";
import { collectGarbage, summarizeGc, type GcOptions, type GcResult } from "./worktree-gc";

// ---------------------------------------------------------------------------
// 경로·설정
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data", "jobs");
const PROJECTS_FILE = process.env.WORKER_PROJECTS_FILE ?? path.join(process.cwd(), "config", "projects.json");
const WORKTREE_ROOT = process.env.WORKER_WORKTREE_ROOT ?? path.join(os.homedir(), "repo", "_worktrees");
const KEEP_WORKTREE = process.env.WORKER_KEEP_WORKTREE === "1";
const UNITY_VERIFY = process.env.WORKER_UNITY_VERIFY !== "0";
const MAX_LOG = 5000;

const minutes = (envName: string, fallback: number) => Math.max(1, Number(process.env[envName] || fallback)) * 60_000;
/** claude 세션 전체 상한 */
const CLAUDE_TIMEOUT_MS = minutes("WORKER_CLAUDE_TIMEOUT_MIN", 90);
/** claude 세션이 이 시간 동안 아무 이벤트도 내지 않으면 멈춘 것으로 본다 */
const CLAUDE_STALL_MS = minutes("WORKER_CLAUDE_STALL_MIN", 20);
/** Unity 배치모드 전체 상한 (첫 임포트 포함) */
const UNITY_TIMEOUT_MS = minutes("WORKER_UNITY_TIMEOUT_MIN", 45);
/** Unity 로그가 이 시간 동안 안 늘면 멈춘 것으로 본다 */
const UNITY_STALL_MS = minutes("WORKER_UNITY_STALL_MIN", 10);
/** git / gh 한 번의 상한 (네트워크 포함) */
const GIT_TIMEOUT_MS = minutes("WORKER_GIT_TIMEOUT_MIN", 10);
/** 스위퍼가 "실행 중인데 프로세스도 없고 활동도 없음"으로 판정하는 기준 */
const SWEEP_STALL_MS = minutes("WORKER_SWEEP_STALL_MIN", 15);

/** acceptEdits만으로는 git 커밋이 승인 대기에 걸린다 — 세션이 스스로 커밋할 수 있게 기본 허용 */
const DEFAULT_ALLOWED_TOOLS =
  process.env.WORKER_CLAUDE_ALLOWED_TOOLS ??
  "Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git add:*),Bash(git commit:*),Bash(git restore:*),Bash(git stash:*)";

type Registry = {
  __jobs?: Map<string, Job>;
  __jobQueues?: Map<string, Promise<void>>;
  __jobProcs?: Map<string, ChildProcess>;
  __jobsLoaded?: Promise<void>;
  __jobSweeper?: NodeJS.Timeout;
  __jobGc?: NodeJS.Timeout;
  __gcRunning?: Promise<GcResult>;
  __lastGc?: GcResult;
};
const g = globalThis as unknown as Registry;
const jobs: Map<string, Job> = g.__jobs ?? new Map();
g.__jobs = jobs;
const queues: Map<string, Promise<void>> = g.__jobQueues ?? new Map();
g.__jobQueues = queues;
const procs: Map<string, ChildProcess> = g.__jobProcs ?? new Map();
g.__jobProcs = procs;

function jobPath(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("invalid job id");
  return path.join(DATA_DIR, `${id}.json`);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** 저장된 잡을 메모리로 올린다. 이전 프로세스에서 진행 중이던 잡은 중단 처리. 최초 1회만. */
function ensureLoaded(): Promise<void> {
  if (!g.__jobsLoaded) {
    g.__jobsLoaded = (async () => {
      await ensureDir();
      const files = await fs.readdir(DATA_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const job = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), "utf8")) as Job;
          if (jobs.has(job.id)) continue;
          if (job.status === "running" || job.status === "queued") {
            job.status = "failed";
            job.error = `서버 재시작으로 중단됨 (${job.stage} 단계). worktree가 남아 있으면 job_resume으로 이어서 마무리할 수 있습니다`;
            job.endedAt = new Date().toISOString();
            await writeJob(job);
          }
          jobs.set(job.id, job);
        } catch {
          // 손상된 파일은 건너뛴다
        }
      }
      startSweeper();
      startGc();
    })();
  }
  return g.__jobsLoaded;
}

/** 잡별 쓰기 직렬화 — 로그 저장과 단계 저장이 같은 tmp 파일을 두고 경합하지 않게 한다. */
const writeChains = new Map<string, Promise<void>>();

function writeJob(job: Job): Promise<void> {
  const prev = writeChains.get(job.id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir();
      const p = jobPath(job.id);
      const tmp = `${p}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
      await fs.rename(tmp, p);
    });
  writeChains.set(job.id, next);
  return next;
}

const pendingSave = new Map<string, NodeJS.Timeout>();
function scheduleSave(job: Job, immediate = false) {
  const existing = pendingSave.get(job.id);
  if (existing) clearTimeout(existing);
  const flush = () => {
    pendingSave.delete(job.id);
    void writeJob(job).catch((e) => console.warn(`[jobs] 저장 실패: ${e instanceof Error ? e.message : e}`));
  };
  if (immediate) return flush();
  const t = setTimeout(flush, 1500);
  t.unref?.();
  pendingSave.set(job.id, t);
}

export async function loadProjects(): Promise<Record<string, ProjectConfig>> {
  let raw: string;
  try {
    raw = await fs.readFile(PROJECTS_FILE, "utf8");
  } catch {
    throw new Error(`프로젝트 설정 파일이 없습니다: ${PROJECTS_FILE} (config/projects.example.json 참고)`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("projects.json은 객체여야 합니다");
  const out: Record<string, ProjectConfig> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`프로젝트 키가 올바르지 않습니다: ${key}`);
    if (!val || typeof val !== "object") throw new Error(`프로젝트 ${key} 설정이 객체가 아닙니다`);
    const v = val as Record<string, unknown>;
    if (typeof v.path !== "string" || !path.isAbsolute(v.path)) throw new Error(`프로젝트 ${key}: path는 절대경로여야 합니다`);
    out[key] = {
      path: v.path,
      baseBranch: typeof v.baseBranch === "string" && v.baseBranch ? v.baseBranch : "main",
      allowDirect: v.allowDirect !== false,
      unityPath: typeof v.unityPath === "string" && v.unityPath ? v.unityPath : undefined,
      unityMcpPort: typeof v.unityMcpPort === "number" ? v.unityMcpPort : undefined,
      setupCommand: typeof v.setupCommand === "string" && v.setupCommand ? v.setupCommand : undefined,
      seedUnityLibrary: v.seedUnityLibrary === true,
      defaultModel: typeof v.defaultModel === "string" && v.defaultModel ? v.defaultModel : undefined,
      defaultEffort: isEffort(v.defaultEffort) ? v.defaultEffort : undefined,
    };
  }
  return out;
}

function isEffort(v: unknown): v is JobEffort {
  return typeof v === "string" && (JOB_EFFORTS as readonly string[]).includes(v);
}

/**
 * 보드에서 프로젝트의 직푸시 허용 여부를 바꾼다.
 * projects.json에서 **`allowDirect`만** 건드린다 — 경로 등 나머지 필드는 파일에 있는 값을 그대로 둔다.
 * (설정 파일을 쓰는 유일한 경로다. 다른 필드를 여기서 열어 주지 않는다.)
 */
export async function setProjectAllowDirect(key: string, allowDirect: boolean): Promise<ProjectConfig> {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`프로젝트 키가 올바르지 않습니다: ${key}`);
  await loadProjects(); // 파일 전체가 유효한지 먼저 확인 (깨진 설정을 덮어쓰지 않게)

  const raw = JSON.parse(await fs.readFile(PROJECTS_FILE, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("projects.json은 객체여야 합니다");
  const entry = (raw as Record<string, unknown>)[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`알 수 없는 프로젝트: ${key}`);
  (entry as Record<string, unknown>).allowDirect = allowDirect;

  const tmp = `${PROJECTS_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await fs.rename(tmp, PROJECTS_FILE);

  const updated = (await loadProjects())[key];
  if (!updated) throw new Error(`설정을 다시 읽지 못했습니다: ${key}`);
  console.log(`[jobs] ${key} 직푸시 ${allowDirect ? "허용" : "잠금"}으로 변경`);
  return updated;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export async function listJobs(): Promise<Job[]> {
  await ensureLoaded();
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getJob(id: string): Promise<Job | null> {
  await ensureLoaded();
  return jobs.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// 제출 · 취소 · 재개
// ---------------------------------------------------------------------------

export interface SubmitJobOptions {
  project: string;
  prompt: string;
  title?: string;
  mode?: JobMode;
  skipPermissions?: boolean;
  model?: string;
  effort?: JobEffort;
  maxTurns?: number;
  /** 플랜 착수 잡이면 플랜 id — prompt는 아래 taskIds로 조립되므로 비워도 된다 */
  planId?: string;
  /** 플랜 착수 잡이 수행할 태스크 id 목록 */
  taskIds?: string[];
  /** 컨텍스트로 참조할 이전 잡 id — 그 잡의 지시·요약·PR이 새 세션 지시문 앞에 붙는다 */
  parentJobId?: string;
  /** "parent"면 이전 잡 브랜치 위에서 worktree를 시작한다 (기본: base 브랜치) */
  startFrom?: "base" | "parent";
  /** 완료 웹훅 링크 생성에 쓸 보드 포트 */
  port?: number;
}

export async function submitJob(opts: SubmitJobOptions): Promise<Job> {
  await ensureLoaded();
  const projects = await loadProjects();
  const cfg = projects[opts.project];
  if (!cfg) throw new Error(`알 수 없는 프로젝트: ${opts.project} (등록: ${Object.keys(projects).join(", ") || "없음"})`);

  // 플랜 착수 잡: 실행 지시문은 worktree·브랜치가 정해진 뒤 runJob이 조립한다.
  // 여기서는 존재·범위만 검증하고, prompt에는 사람이 읽을 요약(알림·PR 본문용)을 넣는다.
  let planTaskIds: string[] | undefined;
  let planTitle: string | undefined;
  let planSummary: string | undefined;
  if (opts.planId !== undefined) {
    const plan = await getPlan(opts.planId);
    if (!plan) throw new Error(`플랜을 찾을 수 없습니다: ${opts.planId}`);
    planTaskIds = (opts.taskIds ?? []).filter((id) => plan.tasks.some((t) => t.id === id));
    if (planTaskIds.length === 0) throw new Error("착수할 태스크가 없습니다");
    planTitle = `${plan.title} — 태스크 ${planTaskIds.length}개`;
    planSummary = [
      `플랜 "${plan.title}" (rev ${plan.revision}) 착수 — 태스크 ${planTaskIds.length}개`,
      ...plan.tasks.filter((t) => planTaskIds!.includes(t.id)).map((t) => `- ${t.title}`),
    ].join("\n");
  }

  // 새 세션이 이전 잡을 참조하면 컨텍스트(지시문 조립 시점)와 시작 브랜치를 물려받는다
  let parent: Job | undefined;
  let startBranch: string | undefined;
  if (opts.parentJobId !== undefined) {
    parent = (await getJob(opts.parentJobId)) ?? undefined;
    if (!parent) throw new Error(`이전 잡을 찾을 수 없습니다: ${opts.parentJobId}`);
    if (parent.project !== opts.project) {
      throw new Error(`이전 잡의 프로젝트(${parent.project})와 달라 컨텍스트를 이어받을 수 없습니다`);
    }
  }
  if (opts.startFrom === "parent") {
    if (!parent) throw new Error("startFrom: parent는 parentJobId와 함께 써야 합니다");
    if (!parent.branch) throw new Error("이전 잡에 브랜치가 없어 그 위에서 시작할 수 없습니다");
    startBranch = parent.branch;
  }

  const prompt = planSummary ?? opts.prompt.trim();
  if (!prompt) throw new Error("prompt가 비어 있습니다");
  const mode: JobMode = opts.mode === "direct" ? "direct" : "pr";
  if (mode === "direct" && cfg.allowDirect === false) {
    throw new Error(`프로젝트 ${opts.project}는 direct 모드가 잠겨 있습니다 (projects.json allowDirect: false)`);
  }
  if (opts.model !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(opts.model)) throw new Error("model 형식이 올바르지 않습니다");
  if (opts.effort !== undefined && !isEffort(opts.effort)) throw new Error(`effort는 ${JOB_EFFORTS.join(" | ")} 중 하나`);
  if (opts.maxTurns !== undefined && (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1 || opts.maxTurns > 1000)) {
    throw new Error("maxTurns는 1~1000 정수");
  }

  const job: Job = {
    id: newId(),
    project: opts.project,
    title: (opts.title?.trim() || planTitle || prompt.split("\n")[0]).slice(0, 80),
    prompt,
    planId: opts.planId,
    taskIds: planTaskIds,
    mode,
    status: "queued",
    stage: "queued",
    createdAt: new Date().toISOString(),
    baseBranch: cfg.baseBranch,
    startBranch,
    parentJobId: parent?.id,
    skipPermissions: opts.skipPermissions === true,
    model: opts.model ?? cfg.defaultModel,
    effort: opts.effort ?? cfg.defaultEffort,
    maxTurns: opts.maxTurns,
    log: [],
  };
  jobs.set(job.id, job);
  pushLog(
    job,
    "info",
    `잡 제출 (project: ${job.project}, mode: ${job.mode}, base: ${job.baseBranch}, model: ${job.model ?? "기본"}, effort: ${job.effort ?? "기본"}${job.planId ? `, plan: ${job.planId.slice(0, 8)}` : ""}${parent ? `, 이전 잡: ${parent.id.slice(0, 8)}${startBranch ? ` (${startBranch} 위에서 시작)` : " (컨텍스트만 참조)"}` : ""})`
  );
  await writeJob(job);
  enqueue(job, cfg, opts.port ?? 3000, { resume: false });
  return job;
}

export async function cancelJob(id: string): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new Error("job not found");
  if (job.status === "queued") {
    finish(job, "cancelled", "제출 취소");
    return job;
  }
  if (job.status === "running") {
    job.status = "cancelled"; // runJob이 이 값을 보고 나머지 단계를 건너뛴다
    pushLog(job, "info", "취소 요청 — 실행 중인 프로세스를 종료합니다");
    killProc(job.id);
    scheduleSave(job, true);
    return job;
  }
  return job;
}

export interface ResumeJobOptions {
  /** true면 Unity 검증을 건너뛴다 */
  skipVerify?: boolean;
  port?: number;
}

/**
 * 실패·취소·중단된 잡을 worktree 그대로 두고 커밋 단계부터 다시 돌린다.
 * claude 세션은 다시 돌리지 않는다 — 이미 만들어진 변경을 원격까지 밀어 넣는 용도.
 */
export async function resumeJob(id: string, opts: ResumeJobOptions = {}): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new Error("job not found");
  if (job.status === "running" || job.status === "queued") throw new Error(`아직 ${job.status} 상태입니다 — 먼저 취소하세요`);
  if (!job.worktree || !job.branch) throw new Error("worktree 정보가 없어 이어서 할 수 없습니다 (새 잡으로 제출하세요)");
  if (job.worktreeRemovedAt) {
    throw new Error(`worktree가 이미 정리됐습니다 (${job.worktreeRemovedAt}) — 새 잡으로 제출하세요`);
  }
  const exists = await fs.stat(job.worktree).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) {
    markWorktreeRemoved(job, "디스크에 없음");
    throw new Error(`worktree가 없습니다: ${job.worktree} — 새 잡으로 제출하세요`);
  }
  const projects = await loadProjects();
  const cfg = projects[job.project];
  if (!cfg) throw new Error(`프로젝트 설정이 사라졌습니다: ${job.project}`);

  job.status = "queued";
  job.stage = "queued";
  job.error = undefined;
  job.endedAt = undefined;
  job.resumeCount = (job.resumeCount ?? 0) + 1;
  pushLog(job, "info", `재개 요청 (${job.resumeCount}회째${opts.skipVerify ? ", 검증 생략" : ""}) — 커밋 단계부터 이어서 진행`);
  scheduleSave(job, true);
  enqueue(job, cfg, opts.port ?? 3000, { resume: true, skipVerify: opts.skipVerify === true });
  return job;
}

export interface FollowUpJobOptions {
  /** 세션에 얹을 추가 지시 */
  prompt: string;
  /** true면 새 잡 카드로 분리한다 (worktree·브랜치·PR·세션은 공유). 기본은 같은 잡에 이어붙이기 */
  asNewJob?: boolean;
  /** asNewJob일 때 제목 (생략 시 추가 지시 첫 줄) */
  title?: string;
  model?: string;
  effort?: JobEffort;
  maxTurns?: number;
  /** true면 Unity 검증을 건너뛴다 */
  skipVerify?: boolean;
  port?: number;
}

/**
 * 끝난 잡의 claude 세션을 그대로 이어(--resume) 추가 지시를 수행한다.
 * worktree·브랜치·PR을 그대로 쓰므로 push는 같은 브랜치를 갱신하고 PR도 재사용된다.
 * 커밋 단계부터만 다시 도는 resumeJob과 달리, 이 경로는 claude를 다시 돌린다.
 */
export async function followUpJob(id: string, opts: FollowUpJobOptions): Promise<Job> {
  const parent = await getJob(id);
  if (!parent) throw new Error("job not found");
  const instruction = opts.prompt.trim();
  if (!instruction) throw new Error("추가 지시가 비어 있습니다");
  if (parent.status === "running" || parent.status === "queued") {
    throw new Error(`아직 ${parent.status} 상태입니다 — 끝난 뒤에 이어서 하세요`);
  }
  if (!parent.worktree || !parent.branch) throw new Error("worktree 정보가 없어 이어서 할 수 없습니다 (새 세션으로 시작하세요)");
  if (parent.worktreeRemovedAt) {
    throw new Error(`worktree가 이미 정리됐습니다 (${parent.worktreeRemovedAt}) — 새 세션으로 시작하세요`);
  }
  const exists = await fs.stat(parent.worktree).then((st) => st.isDirectory()).catch(() => false);
  if (!exists) {
    markWorktreeRemoved(parent, "디스크에 없음");
    throw new Error(`worktree가 없습니다: ${parent.worktree} — 새 세션으로 시작하세요`);
  }
  if (opts.model !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(opts.model)) throw new Error("model 형식이 올바르지 않습니다");
  if (opts.effort !== undefined && !isEffort(opts.effort)) throw new Error(`effort는 ${JOB_EFFORTS.join(" | ")} 중 하나`);
  if (opts.maxTurns !== undefined && (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1 || opts.maxTurns > 1000)) {
    throw new Error("maxTurns는 1~1000 정수");
  }
  const projects = await loadProjects();
  const cfg = projects[parent.project];
  if (!cfg) throw new Error(`프로젝트 설정이 사라졌습니다: ${parent.project}`);

  const sessionNote = parent.sessionId ? `session ${parent.sessionId.slice(0, 8)}` : "이 worktree의 최근 세션";
  const target = opts.asNewJob ? forkJobCard(parent, instruction, opts) : parent;
  if (target === parent) {
    parent.status = "queued";
    parent.stage = "queued";
    parent.error = undefined;
    parent.endedAt = undefined;
    parent.verify = undefined; // 코드가 다시 바뀌므로 검증도 다시 한다
    parent.followUpCount = (parent.followUpCount ?? 0) + 1;
    if (opts.model) parent.model = opts.model;
    if (opts.effort) parent.effort = opts.effort;
    if (opts.maxTurns) parent.maxTurns = opts.maxTurns;
    pushLog(parent, "info", `이어서하기 (${parent.followUpCount}회째, ${sessionNote}): ${instruction.split("\n")[0].slice(0, 120)}`);
  }
  jobs.set(target.id, target);
  await writeJob(target);
  enqueue(target, cfg, opts.port ?? 3000, { resume: false, followUp: instruction, skipVerify: opts.skipVerify === true });
  return target;
}

/** 이어서하기를 새 잡 카드로 분리 — worktree·브랜치·PR·세션은 이전 잡 것을 그대로 쓴다 */
function forkJobCard(parent: Job, instruction: string, opts: FollowUpJobOptions): Job {
  const child: Job = {
    id: newId(),
    project: parent.project,
    title: (opts.title?.trim() || instruction.split("\n")[0]).slice(0, 80),
    prompt: instruction,
    planId: parent.planId,
    taskIds: parent.taskIds,
    mode: parent.mode,
    status: "queued",
    stage: "queued",
    createdAt: new Date().toISOString(),
    baseBranch: parent.baseBranch,
    branch: parent.branch,
    worktree: parent.worktree,
    startBranch: parent.startBranch,
    prUrl: parent.prUrl,
    skipPermissions: parent.skipPermissions,
    model: opts.model ?? parent.model,
    effort: opts.effort ?? parent.effort,
    maxTurns: opts.maxTurns ?? parent.maxTurns,
    sessionId: parent.sessionId,
    parentJobId: parent.id,
    log: [],
  };
  pushLog(
    child,
    "info",
    `이어서하기 — 잡 ${parent.id.slice(0, 8)}의 worktree·세션을 이어받습니다 (branch: ${child.branch}${child.sessionId ? `, session: ${child.sessionId.slice(0, 8)}` : ""})`
  );
  pushLog(parent, "info", `이어서하기: 새 잡 ${child.id.slice(0, 8)}이 이 worktree·세션을 이어받았습니다`);
  scheduleSave(parent, true);
  return child;
}

interface RunOptions {
  /** true면 worktree·claude 단계를 건너뛰고 커밋 단계부터 (job_resume) */
  resume: boolean;
  /** 있으면 기존 worktree에서 claude 세션을 이어 돌린다 (이어서하기의 추가 지시) */
  followUp?: string;
  skipVerify?: boolean;
}

function enqueue(job: Job, cfg: ProjectConfig, port: number, run: RunOptions) {
  const prev = queues.get(job.project) ?? Promise.resolve();
  const next = prev
    .then(() => runJob(job, cfg, port, run))
    .catch((e) => console.warn(`[jobs] 큐 오류: ${e instanceof Error ? e.message : e}`));
  queues.set(job.project, next);
}

// ---------------------------------------------------------------------------
// 로그 · 상태
// ---------------------------------------------------------------------------

function pushLog(job: Job, kind: RunLogLine["kind"], text: string) {
  const ts = new Date().toISOString();
  job.log.push({ ts, kind, text });
  job.lastActivityAt = ts;
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  scheduleSave(job);
}

function setStage(job: Job, stage: JobStage) {
  job.stage = stage;
  pushLog(job, "system", `단계: ${stage}`);
  scheduleSave(job, true);
}

function finish(job: Job, status: Job["status"], error?: string) {
  if (job.status !== "cancelled" || status === "cancelled") job.status = status;
  if (error) job.error = error;
  job.endedAt = new Date().toISOString();
  if (job.status === "succeeded") job.stage = "done";
  pushLog(job, job.status === "succeeded" ? "result" : "stderr", error ?? "완료");
  scheduleSave(job, true);
}

function isCancelled(job: Job) {
  return job.status === "cancelled";
}

/** 실행 중인 자식(과 그 손자들)을 종료한다 — 취소·워치독 공용 */
function killProc(jobId: string) {
  const proc = procs.get(jobId);
  if (proc) killTree(proc);
}

// ---------------------------------------------------------------------------
// 외부 프로세스 실행 (워치독 포함)
// ---------------------------------------------------------------------------

type ExecResult = ProcResult;

interface ExecOptions {
  cwd: string;
  quiet?: boolean;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 전체 상한 */
  timeoutMs?: number;
  /** 이 시간 동안 stdout/stderr가 없으면 정지로 판정 */
  stallMs?: number;
  /** stdout 청크 콜백 (스트리밍 파싱용) */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** 외부 명령 실행. 인자 배열로만 넘긴다(셸 미사용). 출력은 잡 로그에 남긴다. */
async function exec(job: Job, cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  if (!opts.quiet) pushLog(job, "tool", `$ ${cmd} ${args.join(" ")}`);
  const touch = () => {
    job.lastActivityAt = new Date().toISOString();
  };
  const res = await spawnWatched(cmd, args, {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs,
    onSpawn: (child) => procs.set(job.id, child),
    onStdout: (s) => {
      touch();
      opts.onStdout?.(s);
    },
    onStderr: (s) => {
      touch();
      opts.onStderr?.(s);
    },
    onWatchdog: (reason, limitMs) =>
      pushLog(
        job,
        "stderr",
        reason === "timeout"
          ? `워치독: ${Math.round(limitMs / 60_000)}분 상한 초과 — 프로세스 종료`
          : `워치독: ${Math.round(limitMs / 60_000)}분간 출력 없음 — 멈춘 것으로 보고 프로세스 종료`
      ),
  });
  procs.delete(job.id);

  if (res.spawnError) {
    pushLog(job, "stderr", `${cmd} 실행 실패: ${res.spawnError}`);
  } else if (!opts.quiet) {
    const out = res.stdout.trim();
    const err = res.stderr.trim();
    if (out) pushLog(job, "info", out.slice(-1500));
    if (err) pushLog(job, res.code === 0 ? "info" : "stderr", err.slice(-1500));
  }
  return res;
}

function git(job: Job, cwd: string, args: string[], quiet = false) {
  return exec(job, "git", args, { cwd, quiet, timeoutMs: GIT_TIMEOUT_MS });
}

/**
 * worktree 시작점(= 커밋 수를 세는 기준점)을 정한다.
 * job.startBranch가 있으면 그 브랜치(원격 우선), 없으면 origin/<base>.
 * strict(새 worktree를 만들 때)는 지정한 브랜치를 못 찾으면 실패시키고,
 * 아니면(이미 만든 worktree에서 다시 셀 때) base 기준으로 물러선다.
 */
async function resolveStartPoint(job: Job, repo: string, base: string, strict: boolean): Promise<string> {
  const from = job.startBranch;
  if (from && from !== base) {
    const fetched = await git(job, repo, ["fetch", "origin", from], true);
    if (fetched.code === 0 && (await git(job, repo, ["rev-parse", "--verify", `origin/${from}`], true)).code === 0) {
      pushLog(job, "info", `시작점: origin/${from}`);
      return `origin/${from}`;
    }
    if ((await git(job, repo, ["rev-parse", "--verify", from], true)).code === 0) {
      pushLog(job, "info", `시작점: 로컬 ${from}`);
      return from;
    }
    if (strict) throw new Error(`시작 브랜치를 찾을 수 없습니다: ${from} (원격·로컬 모두 없음)`);
    pushLog(job, "info", `시작 브랜치 ${from}를 찾지 못해 ${base} 기준으로 셉니다`);
  }
  const fetched = await git(job, repo, ["fetch", "origin", base], !strict);
  if (fetched.code !== 0) {
    if (strict) pushLog(job, "info", `origin fetch 실패 — 로컬 ${base}에서 분기합니다`);
    return base;
  }
  return `origin/${base}`;
}

// ---------------------------------------------------------------------------
// claude 세션
// ---------------------------------------------------------------------------

function buildJobPrompt(job: Job, worktree: string, parent?: Job): string {
  return `너는 원격 워커 세션이다. 아래 조건에서 작업하라.

- 프로젝트: ${job.project}
- 작업 디렉터리(worktree): ${worktree}
- 현재 브랜치: ${job.branch} (기준: ${job.startBranch ?? job.baseBranch})
- 결과 처리 모드: ${job.mode === "pr" ? "PR 생성" : `${job.baseBranch}에 직접 반영`}

${parentContext(job, parent)}## 지시
${job.prompt}

## 마무리 규칙 (필수)
- 작업이 끝나면 변경 사항을 커밋한다. 커밋 메시지는 이 프로젝트의 CLAUDE.md 커밋 규칙을 따른다.
  git add / git commit은 승인 없이 실행할 수 있다. 커밋이 막히면 변경을 워킹트리에 남겨 두어라 — 워커가 대신 커밋한다.
- **push 하지 않는다.** push·PR 생성은 워커가 처리한다.
- 브랜치를 바꾸거나 worktree 밖의 경로를 수정하지 않는다.
- 마지막 응답에 수행한 작업·검증 결과·남은 문제를 짧게 요약한다.`;
}

/**
 * 이전 잡을 참조해 만든 새 세션이면 그 잡의 결과를 컨텍스트로 앞에 붙인다.
 * 새 세션은 이전 세션의 대화를 물려받지 않으므로, 요약·브랜치·PR만 텍스트로 넘긴다.
 */
function parentContext(job: Job, parent?: Job): string {
  if (!parent) return "";
  const bullets = [
    `- 이전 잡 결과: ${parent.status}${parent.verify ? ` · Unity 검증 ${verifyLabel(parent.verify)}` : ""}`,
    parent.branch ? `- 이전 브랜치: ${parent.branch}` : null,
    parent.prUrl ? `- 이전 PR: ${parent.prUrl}` : null,
    job.startBranch && job.startBranch === parent.branch
      ? "- 이번 worktree는 그 브랜치 위에서 시작했다 — 이전 변경이 이미 코드에 들어 있다."
      : `- 이번 worktree는 ${job.baseBranch}에서 새로 시작했다 — 이전 변경은 이 코드에 없다.`,
    parent.error ? `- 이전 잡 오류: ${parent.error}` : null,
  ].filter((l): l is string => l !== null);

  return `## 이전 작업 컨텍스트 (참고용)
이 작업은 이전 잡 "${parent.title}" (job ${parent.id.slice(0, 8)})의 후속이다.

${bullets.join("\n")}

### 이전 지시
${parent.prompt.trim()}

### 이전 세션 요약
${lastResult(parent)}

`;
}

/** 이어서하기 — 컨텍스트를 이미 가진 세션에 추가 지시만 얹는다 (규칙은 세션이 이미 알고 있다) */
function buildFollowUpPrompt(job: Job, instruction: string): string {
  return `이어서 작업한다. 지금까지의 작업 내용·결정을 그대로 유지한 채 아래 추가 지시를 수행하라.

## 추가 지시
${instruction}

## 마무리 규칙 (변함없음)
- 작업이 끝나면 변경 사항을 커밋한다. 커밋 메시지는 이 프로젝트의 CLAUDE.md 커밋 규칙을 따른다.
  git add / git commit은 승인 없이 실행할 수 있다. 커밋이 막히면 변경을 워킹트리에 남겨 두어라 — 워커가 대신 커밋한다.
- **push 하지 않는다.** push·PR 생성은 워커가 처리한다.
- 브랜치(${job.branch})를 바꾸거나 worktree 밖의 경로를 수정하지 않는다.
- 마지막 응답에 이번에 한 일·검증 결과·남은 문제를 짧게 요약한다.`;
}

/** 플랜 착수 잡의 실행 지시문 — worktree·브랜치가 정해진 뒤에 조립한다 */
async function buildPlanJobPrompt(job: Job, worktree: string): Promise<string> {
  const plan = await getPlan(job.planId!);
  if (!plan) throw new Error(`플랜을 찾을 수 없습니다: ${job.planId}`);
  return buildPlanPrompt(plan, job.taskIds ?? [], {
    kind: "worktree",
    project: job.project,
    worktree,
    branch: job.branch,
    baseBranch: job.baseBranch,
    mode: job.mode,
  });
}

/** 세션 이어가기 옵션 — resume이면 job.sessionId(없으면 이 worktree의 최근 세션)를 이어받는다 */
interface ClaudeSessionOptions {
  resume?: boolean;
}

async function runClaude(
  job: Job,
  worktree: string,
  prompt: string,
  progress?: PlanProgress,
  session?: ClaudeSessionOptions
): Promise<boolean> {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (session?.resume) {
    // worktree는 잡마다 고유하므로, 세션 id를 모르면 이 디렉터리의 최근 대화를 이어도 같은 세션이다
    if (job.sessionId) args.push("--resume", job.sessionId);
    else args.push("--continue");
  }
  if (job.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "acceptEdits");
    if (DEFAULT_ALLOWED_TOOLS) args.push("--allowedTools", ...DEFAULT_ALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean));
  }
  if (job.model) args.push("--model", job.model);
  if (job.effort) args.push("--effort", job.effort);
  if (job.maxTurns) args.push("--max-turns", String(job.maxTurns));
  pushLog(job, "info", `claude ${args.join(" ")}  (cwd: ${worktree})`);

  let resultOk: boolean | undefined;
  const parser = createLineParser((ev) => {
    if (ev.resultOk !== undefined) resultOk = ev.resultOk;
    // 세션 id는 "이어서하기"(--resume)의 기준 — 바뀔 때마다 잡에 남긴다
    if (ev.sessionId && ev.sessionId !== job.sessionId) {
      job.sessionId = ev.sessionId;
      scheduleSave(job);
    }
    if (progress && (ev.kind === "assistant" || ev.kind === "result")) {
      progress.apply(ev.text);
      const clean = stripMarkers(ev.text) || (ev.kind === "result" ? "완료" : "");
      if (clean) pushLog(job, ev.kind, clean);
      return;
    }
    pushLog(job, ev.kind, ev.text);
  });

  const result = await spawnWatched("claude", args, {
    cwd: worktree,
    shell: process.platform === "win32",
    input: prompt,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    stallMs: CLAUDE_STALL_MS,
    onSpawn: (child) => procs.set(job.id, child),
    onStdout: (s) => parser.push(s),
    onStderr: (s) => {
      const t = s.trim();
      if (t) pushLog(job, "stderr", t.slice(0, 1000));
    },
    onWatchdog: (reason, limitMs) =>
      pushLog(
        job,
        "stderr",
        reason === "timeout"
          ? `워치독: claude 세션 ${Math.round(limitMs / 60_000)}분 상한 초과 — 종료`
          : `워치독: claude 세션이 ${Math.round(limitMs / 60_000)}분간 이벤트 없음 — 멈춘 것으로 보고 종료`
      ),
  });
  procs.delete(job.id);
  parser.flush();
  if (result.spawnError) {
    pushLog(job, "stderr", `claude CLI 실행 실패: ${result.spawnError} — claude가 PATH에 있는지 확인하세요.`);
    return false;
  }
  pushLog(job, "info", `claude 종료 (exit ${result.code}${result.killed ? `, 워치독 ${result.killed}` : ""})`);

  if (result.killed) return false;
  return result.code === 0 && resultOk !== false;
}

// ---------------------------------------------------------------------------
// Unity 검증
// ---------------------------------------------------------------------------

async function isUnityProject(dir: string) {
  return fs
    .stat(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))
    .then(() => true)
    .catch(() => false);
}

/** 메인 clone의 Library/를 APFS clonefile로 복사 — 첫 임포트 수십 분을 아낀다 (macOS 전용, 옵션) */
async function seedLibrary(job: Job, cfg: ProjectConfig, worktree: string) {
  if (!cfg.seedUnityLibrary || process.platform !== "darwin") return;
  const src = path.join(cfg.path, "Library");
  const dst = path.join(worktree, "Library");
  const has = await fs.stat(src).then((s) => s.isDirectory()).catch(() => false);
  if (!has) return;
  const already = await fs.stat(dst).then(() => true).catch(() => false);
  if (already) return;
  pushLog(job, "info", "Library/ clonefile 복사 (cp -Rc) — Unity 첫 임포트 단축");
  const r = await exec(job, "cp", ["-Rc", src, dst], { cwd: worktree, quiet: true, timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) {
    pushLog(job, "stderr", "Library/ 복사 실패 — 원본 임포트로 진행합니다");
    await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 배치모드 컴파일. 반환값은 job.verify에 그대로 들어간다. */
async function verifyUnity(job: Job, cfg: ProjectConfig, worktree: string): Promise<Job["verify"]> {
  if (!cfg.unityPath || !UNITY_VERIFY) return "skipped";
  if (!(await isUnityProject(worktree))) {
    pushLog(job, "info", "Unity 프로젝트가 아니라 검증을 건너뜁니다");
    return "skipped";
  }
  const logFile = path.join(DATA_DIR, `${job.id}-unity.log`);
  const logHandle = await fs.open(logFile, "a");
  pushLog(
    job,
    "info",
    `Unity 배치모드 컴파일 검증 시작 (로그: ${logFile}, 상한 ${Math.round(UNITY_TIMEOUT_MS / 60_000)}분, 무출력 ${Math.round(UNITY_STALL_MS / 60_000)}분이면 중단)`
  );
  let lastMilestone = "";
  try {
    // -logFile - : 로그를 stdout으로 → 워치독이 진행 여부를 볼 수 있다. 파일에도 그대로 남긴다.
    const r = await exec(
      job,
      cfg.unityPath,
      ["-batchmode", "-nographics", "-quit", "-projectPath", worktree, "-logFile", "-"],
      {
        cwd: worktree,
        quiet: true,
        timeoutMs: UNITY_TIMEOUT_MS,
        stallMs: UNITY_STALL_MS,
        onStdout: (chunk) => {
          void logHandle.write(chunk);
          // 사람이 볼 만한 이정표만 잡 로그에 남긴다
          const m = /(Start importing|Refreshing native plugins|Compil\w+ scripts|error CS\d+|Scripts have compiler errors|Exiting batchmode)[^\n]{0,160}/.exec(chunk);
          if (m && m[0] !== lastMilestone) {
            lastMilestone = m[0];
            pushLog(job, "info", `unity: ${m[0]}`);
          }
        },
        onStderr: (chunk) => void logHandle.write(chunk),
      }
    );
    if (r.killed) {
      pushLog(job, "stderr", `Unity 검증 ${r.killed === "timeout" ? "시간 초과" : "정지 감지"} — 로그: ${logFile}`);
      return "timeout";
    }
    if (r.code !== 0) {
      const tail = await fs.readFile(logFile, "utf8").then((t) => t.slice(-2000)).catch(() => "");
      const errs = tail
        .split("\n")
        .filter((l) => /error CS\d+|Scripts have compiler errors/.test(l))
        .slice(0, 8)
        .join("\n");
      pushLog(job, "stderr", `Unity 검증 실패 (exit ${r.code})${errs ? `\n${errs}` : ""}`);
      return "failed";
    }
    pushLog(job, "info", "Unity 컴파일 검증 통과");
    return "passed";
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}

/** gh pr view --json state,url 출력 파싱 — 외부 명령 출력이므로 파싱 후 검증한다 */
function parsePrView(stdout: string): { state: string; url: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { state?: unknown; url?: unknown };
  const state = typeof o.state === "string" ? o.state : "";
  const url = typeof o.url === "string" && o.url.startsWith("https://") ? o.url : "";
  return state && url ? { state, url } : null;
}

function verifyLabel(v: Job["verify"]) {
  return v === "passed" ? "통과" : v === "failed" ? "실패" : v === "timeout" ? "시간 초과/정지" : "생략";
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

async function runJob(job: Job, cfg: ProjectConfig, port: number, run: RunOptions): Promise<void> {
  if (isCancelled(job)) return;
  job.status = "running";
  job.startedAt = job.startedAt ?? new Date().toISOString();
  if (!run.resume && !run.followUp) {
    job.branch = `agent/${job.id.slice(0, 8)}`;
    job.worktree = path.join(WORKTREE_ROOT, `${job.project}-${job.id.slice(0, 8)}`);
  }
  const worktree = job.worktree!;
  const branch = job.branch!;
  scheduleSave(job, true);

  const repo = cfg.path;
  const base = job.baseBranch;
  let pushed = false;
  let startPoint = `origin/${base}`;

  const checkCancel = () => {
    if (isCancelled(job)) throw new CancelledError();
  };

  try {
    if (!run.resume) {
      if (!run.followUp) {
        // 1. worktree
        setStage(job, "worktree");
        await fs.mkdir(WORKTREE_ROOT, { recursive: true });
        startPoint = await resolveStartPoint(job, repo, base, true);
        const wt = await git(job, repo, ["worktree", "add", "-b", branch, worktree, startPoint]);
        if (wt.code !== 0) throw new Error(`worktree 생성 실패 (exit ${wt.code})`);
        await seedLibrary(job, cfg, worktree);
        if (cfg.setupCommand) {
          const setup = await exec(job, cfg.setupCommand, [], { cwd: worktree, shell: true, timeoutMs: GIT_TIMEOUT_MS });
          if (setup.code !== 0) throw new Error(`setupCommand 실패 (exit ${setup.code})`);
        }
      } else {
        // 이어서하기: worktree·브랜치는 그대로 두고 세션만 이어 돈다
        pushLog(job, "info", `기존 worktree에서 세션을 이어 갑니다: ${worktree}`);
        startPoint = await resolveStartPoint(job, repo, base, false);
      }
      checkCancel();

      // 2. claude
      setStage(job, "claude");
      let progress: PlanProgress | undefined;
      let prompt: string;
      if (run.followUp) {
        // 세션이 이미 컨텍스트를 갖고 있으므로 추가 지시만 넘긴다.
        // 플랜 착수 잡이면 마커는 계속 반영하되, 확정된 태스크 상태를 beginPlanTasks로 되돌리지 않는다.
        prompt = buildFollowUpPrompt(job, run.followUp);
        if (job.planId) {
          progress = createPlanProgress(job.planId, job.taskIds ?? [], (kind, text) => pushLog(job, kind, text));
        }
      } else if (job.planId) {
        prompt = await buildPlanJobPrompt(job, worktree);
        const taskIds = job.taskIds ?? [];
        progress = createPlanProgress(job.planId, taskIds, (kind, text) => pushLog(job, kind, text));
        await beginPlanTasks(job.planId, taskIds);
      } else {
        prompt = buildJobPrompt(job, worktree, job.parentJobId ? jobs.get(job.parentJobId) : undefined);
      }
      const ok = await runClaude(job, worktree, prompt, progress, { resume: Boolean(run.followUp) });
      // 세션이 끝났으면 남은 태스크 상태를 확정한다 (이후 단계는 git 처리라 태스크 진행과 무관)
      if (progress) await progress.finalize(ok);
      checkCancel();
      if (!ok) {
        // 세션이 죽었어도 변경이 있으면 아래 커밋·push 단계로 넘겨 원격에 남긴다 (pr 모드)
        const dirty = (await git(job, worktree, ["status", "--porcelain"], true)).stdout.trim();
        const ahead = Number((await git(job, worktree, ["rev-list", "--count", `${startPoint}..HEAD`], true)).stdout.trim()) || 0;
        if (job.mode !== "pr" || (!dirty && ahead === 0)) throw new Error("claude 세션이 실패로 끝났습니다 — 로그를 확인하세요");
        pushLog(job, "stderr", "claude 세션이 비정상 종료됐지만 변경이 있어 pr 모드로 원격에 보존합니다 — PR을 검토하세요");
        job.error = "claude 세션 비정상 종료 (변경은 PR로 보존됨)";
      }
    } else {
      startPoint = await resolveStartPoint(job, repo, base, false);
    }

    // 3. commit (에이전트가 커밋을 안 했으면 워커가 대신)
    setStage(job, "commit");
    const status = await git(job, worktree, ["status", "--porcelain"], true);
    if (status.stdout.trim()) {
      await git(job, worktree, ["add", "-A"]);
      const commit = await git(job, worktree, ["commit", "-m", `에이전트 - ${job.title}`]);
      if (commit.code !== 0) throw new Error("커밋 실패");
    }
    const count = await git(job, worktree, ["rev-list", "--count", `${startPoint}..HEAD`], true);
    const counted = count.code === 0 ? Number(count.stdout.trim()) : NaN;
    // 기준점을 못 세면(시작 브랜치가 사라진 경우 등) 변경 없음으로 단정하지 않고 push까지 진행한다
    job.commitCount = Number.isFinite(counted) ? counted : undefined;
    scheduleSave(job, true);
    if (job.commitCount === 0) {
      pushLog(job, "info", "변경 사항 없음 — push/PR을 건너뜁니다");
      if (!KEEP_WORKTREE) {
        const rm = await git(job, repo, ["worktree", "remove", "--force", worktree], true);
        if (rm.code === 0) markWorktreeRemoved(job, "변경 사항 없음");
      }
      finish(job, "succeeded");
      return;
    }
    checkCancel();

    if (job.mode === "pr") {
      // 4. push 먼저 — 검증이 오래 걸리거나 죽어도 작업물은 원격에 남는다
      setStage(job, "push");
      const push = await git(job, worktree, ["push", "-u", "origin", branch]);
      if (push.code !== 0) throw new Error("브랜치 push 실패");
      pushed = true;
      checkCancel();

      // 5. verify
      if (run.skipVerify) {
        job.verify = "skipped";
        pushLog(job, "info", "재개 옵션으로 Unity 검증 생략");
      } else {
        setStage(job, "verify");
        job.verify = await verifyUnity(job, cfg, worktree);
        scheduleSave(job, true);
        checkCancel();
      }

      // 6. PR — 열려 있는 PR이 있으면 재사용하고, 이미 머지·클로즈됐으면 새로 만든다
      //    (이어서한 잡은 이전 PR이 머지된 뒤에 커밋이 더 붙을 수 있다)
      setStage(job, "pr");
      const existing = await exec(job, "gh", ["pr", "view", branch, "--json", "state,url"], {
        cwd: worktree,
        quiet: true,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (existing.code === 0) {
        const found = parsePrView(existing.stdout);
        if (found?.state === "OPEN") {
          if (job.prUrl !== found.url) pushLog(job, "info", `기존 PR 재사용: ${found.url}`);
          job.prUrl = found.url;
        } else {
          if (job.prUrl && found) pushLog(job, "info", `이전 PR이 ${found.state} 상태입니다 — 이번 변경은 새 PR로 올립니다`);
          job.prUrl = undefined;
        }
      }
      if (!job.prUrl) {
        const verifyLine =
          job.verify === "passed"
            ? "Unity 컴파일 검증: 통과"
            : job.verify === "skipped"
              ? "Unity 컴파일 검증: 생략"
              : `**Unity 컴파일 검증: ${verifyLabel(job.verify)} — 머지 전 확인 필요**`;
        const body = `자동 생성 — 원격 워커 잡 ${job.id}\n\n${verifyLine}\n\n## 지시\n${job.prompt}\n\n## 세션 요약\n${lastResult(job)}`;
        const title = job.verify === "failed" || job.verify === "timeout" ? `[검증 ${verifyLabel(job.verify)}] ${job.title}` : job.title;
        const pr = await exec(job, "gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], {
          cwd: worktree,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (pr.code !== 0) throw new Error("PR 생성 실패 — 브랜치는 push됐습니다 (gh auth 상태 확인 후 job_resume)");
        const url = pr.stdout.trim().split("\n").find((l) => l.startsWith("https://"));
        if (url) job.prUrl = url;
        scheduleSave(job, true);
      }
    } else {
      // direct: 검증 → 최신 base 위로 rebase → fast-forward push
      if (run.skipVerify) {
        job.verify = "skipped";
        pushLog(job, "info", "재개 옵션으로 Unity 검증 생략");
      } else {
        setStage(job, "verify");
        job.verify = await verifyUnity(job, cfg, worktree);
        scheduleSave(job, true);
        checkCancel();
        if (job.verify === "failed" || job.verify === "timeout") {
          throw new Error(`Unity 검증 ${verifyLabel(job.verify)} — direct 모드는 push하지 않습니다. 확인 후 job_resume(skipVerify) 또는 pr 모드로 재제출`);
        }
      }
      setStage(job, "push");
      const refetch = await git(job, worktree, ["fetch", "origin", base]);
      if (refetch.code === 0) {
        const rebase = await git(job, worktree, ["rebase", `origin/${base}`]);
        if (rebase.code !== 0) {
          await git(job, worktree, ["rebase", "--abort"], true);
          throw new Error(`origin/${base} 위로 rebase 실패 — 충돌을 수동으로 해결한 뒤 job_resume`);
        }
      }
      const push = await git(job, worktree, ["push", "origin", `HEAD:${base}`]);
      if (push.code !== 0) throw new Error(`${base} push 실패`);
      pushed = true;
    }

    // 7. cleanup — 검증을 통과·생략한 경우만. 실패/정지면 사람이 볼 수 있게 남긴다.
    //    여기서 남긴 worktree도 보관 기한이 지나면 GC가 치운다 (runWorktreeGc).
    setStage(job, "cleanup");
    const keep = KEEP_WORKTREE || job.verify === "failed" || job.verify === "timeout";
    if (!keep) {
      const rm = await git(job, repo, ["worktree", "remove", "--force", worktree]);
      if (rm.code === 0) markWorktreeRemoved(job, "잡 완료");
      // pr 모드 브랜치는 원격에 올라가 있으니 로컬 사본은 필요 없다 (PR 머지 뒤 원격은 GC가 정리)
      await git(job, repo, ["branch", "-D", branch], true);
    } else {
      pushLog(job, "info", `worktree 유지: ${worktree} (보관 기한이 지나면 자동 정리)`);
    }
    finish(job, "succeeded", job.error);
  } catch (e) {
    if (e instanceof CancelledError || isCancelled(job)) {
      finish(job, "cancelled", `취소됨 (${job.stage} 단계)${pushed ? ` — 브랜치 ${branch}는 push됨` : ""}`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      finish(job, "failed", pushed ? `${msg} (브랜치 ${branch}는 push됨)` : msg);
    }
  } finally {
    if (isCancelled(job) && !job.endedAt) finish(job, "cancelled", `취소됨 (${job.stage} 단계)`);
    await git(job, repo, ["worktree", "prune"], true);
    void notifyJobFinished(job, port);
    // 잡이 끝날 때마다 기한 지난 잔여물을 훑는다 — 잡을 계속 돌리는 동안 알아서 줄어들게
    gcSoon(port);
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

function lastResult(job: Job): string {
  const r = [...job.log].reverse().find((l) => l.kind === "result");
  return r?.text ?? "(요약 없음)";
}

// ---------------------------------------------------------------------------
// 스위퍼 — 프로세스도 없고 활동도 없는데 running인 잡을 실패로 확정한다.
// 워치독이 프로세스 단위로 막지만, 큐 로직 버그·예외 누락 같은 남은 구멍을 메우는 안전망.
// ---------------------------------------------------------------------------

function startSweeper() {
  if (g.__jobSweeper) return;
  g.__jobSweeper = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.status !== "running") continue;
      if (procs.has(job.id)) continue;
      const last = +new Date(job.lastActivityAt ?? job.startedAt ?? job.createdAt);
      if (now - last < SWEEP_STALL_MS) continue;
      finish(job, "failed", `스위퍼: ${Math.round(SWEEP_STALL_MS / 60_000)}분간 프로세스·활동 없음 (${job.stage} 단계) — job_resume으로 이어서 마무리 가능`);
      void notifyJobFinished(job, 3000);
    }
  }, 60_000);
  g.__jobSweeper.unref?.();
}

// ---------------------------------------------------------------------------
// 워크트리 GC — 남겨 둔 worktree·브랜치를 기한이 지나면 반드시 치운다.
// 잡은 일부러 흔적을 남기므로(job_resume 대비) 치우는 주체가 따로 있어야 한다.
// 정책·판정은 lib/worktree-gc.ts, 여기서는 실행 시점과 잡 기록 반영만 맡는다.
// ---------------------------------------------------------------------------

/** GC 주기 — 서버가 떠 있는 동안 이 간격으로 한 번씩 돈다 */
const GC_INTERVAL_MS = minutes("WORKER_GC_INTERVAL_MIN", 60);

/** worktree가 사라졌음을 잡 기록에 반영한다 (보드의 "이어서 마무리"가 헛돌지 않게) */
function markWorktreeRemoved(job: Job, note: string) {
  if (job.worktreeRemovedAt) return;
  job.worktreeRemovedAt = new Date().toISOString();
  pushLog(job, "info", `worktree 정리됨: ${job.worktree} (${note})`);
  scheduleSave(job, true);

  // 이어서하기로 같은 worktree를 공유하는 잡들도 함께 표시한다 (헛도는 재개·이어서하기 방지)
  if (!job.worktree) return;
  const shared = path.resolve(job.worktree);
  for (const other of jobs.values()) {
    if (other.id === job.id || other.worktreeRemovedAt || !other.worktree) continue;
    if (path.resolve(other.worktree) !== shared) continue;
    other.worktreeRemovedAt = job.worktreeRemovedAt;
    pushLog(other, "info", `worktree 정리됨: ${other.worktree} (${note} — 잡 ${job.id.slice(0, 8)})`);
    scheduleSave(other, true);
  }
}

/**
 * 정리 한 번. 같은 시점에 두 번 돌지 않게 단일 실행으로 묶는다(dry run은 예외 — 조회용).
 * 실패해도 잡 흐름을 막지 않는다.
 */
export async function runWorktreeGc(opts: GcOptions = {}, port = 3000): Promise<GcResult> {
  await ensureLoaded();
  const start = async (): Promise<GcResult> => {
    const projects = await loadProjects().catch((e) => {
      console.warn(`[gc] 프로젝트 설정을 읽지 못했습니다: ${e instanceof Error ? e.message : e}`);
      return {} as Record<string, ProjectConfig>;
    });
    const result = await collectGarbage(
      {
        jobs: [...jobs.values()],
        projects,
        worktreeRoot: WORKTREE_ROOT,
        keepAll: KEEP_WORKTREE,
        onWorktreeRemoved: markWorktreeRemoved,
      },
      opts
    );
    if (!opts.dryRun) {
      const removed = result.worktrees.filter((w) => w.action === "removed").length;
      if (removed > 0 || result.removedLocalBranches.length > 0 || result.removedRemoteBranches.length > 0) {
        console.log(`[gc] ${summarizeGc(result)}`);
        void notifyWorktreeGc(result, port);
      }
      for (const e of result.errors) console.warn(`[gc] ${e}`);
    }
    return result;
  };

  if (opts.dryRun) return start();
  const running = g.__gcRunning;
  if (running) return running;
  const p = start().finally(() => {
    if (g.__gcRunning === p) g.__gcRunning = undefined;
  });
  g.__gcRunning = p;
  g.__lastGc = await p;
  return p;
}

/** 마지막 정리 결과 (서버가 사는 동안만) */
export function lastWorktreeGc(): GcResult | undefined {
  return g.__lastGc;
}

function gcSoon(port: number, delayMs = 5_000) {
  const t = setTimeout(() => {
    void runWorktreeGc({}, port).catch((e) => console.warn(`[gc] 실패: ${e instanceof Error ? e.message : e}`));
  }, delayMs);
  t.unref?.();
}

function startGc() {
  if (g.__jobGc) return;
  g.__jobGc = setInterval(() => {
    void runWorktreeGc().catch((e) => console.warn(`[gc] 실패: ${e instanceof Error ? e.message : e}`));
  }, GC_INTERVAL_MS);
  g.__jobGc.unref?.();
  // 서버가 오래 꺼져 있는 동안 기한이 지난 것들이 있다 — 기동 직후에도 한 번 돈다
  gcSoon(3000, 30_000);
}
