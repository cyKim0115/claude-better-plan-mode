// 원격 워커 잡 — 다른 PC의 에이전트가 worker MCP로 제출한 작업을
// 프로젝트별 직렬 큐에 태워 worktree → claude -p → 커밋 → (Unity 검증) → push/PR → 정리 순으로 돌린다.
//
// - 잡 메타·로그는 data/jobs/<id>.json에 저장 (서버 재시작 후에도 이력 조회 가능).
// - 실행 중 프로세스 핸들은 인메모리(globalThis) — 단일 서버 프로세스 전제(README).
// - 셸 문자열 보간으로 명령을 만들지 않는다. 잡 내용(제목·프롬프트)은 신뢰 입력이 아니다.

import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Job, JobMode, JobStage, ProjectConfig, RunLogLine } from "./types";
import { newId } from "./store";
import { notifyJobFinished } from "./notify";
import { createLineParser } from "./stream-json";

// ---------------------------------------------------------------------------
// 경로·설정
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data", "jobs");
const PROJECTS_FILE = process.env.WORKER_PROJECTS_FILE ?? path.join(process.cwd(), "config", "projects.json");
const WORKTREE_ROOT = process.env.WORKER_WORKTREE_ROOT ?? path.join(os.homedir(), "repo", "_worktrees");
const KEEP_WORKTREE = process.env.WORKER_KEEP_WORKTREE === "1";
const UNITY_VERIFY = process.env.WORKER_UNITY_VERIFY !== "0";
const MAX_LOG = 5000;

type Registry = {
  __jobs?: Map<string, Job>;
  __jobQueues?: Map<string, Promise<void>>;
  __jobProcs?: Map<string, ChildProcess>;
  __jobsLoaded?: Promise<void>;
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
            job.error = "서버 재시작으로 중단됨 (worktree는 남아 있을 수 있음)";
            job.endedAt = new Date().toISOString();
            await writeJob(job);
          }
          jobs.set(job.id, job);
        } catch {
          // 손상된 파일은 건너뛴다
        }
      }
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

/** 로그가 자주 붙으므로 저장은 잡별로 직렬화 + 짧게 묶는다. */
const pendingSave = new Map<string, NodeJS.Timeout>();
function scheduleSave(job: Job, immediate = false) {
  const existing = pendingSave.get(job.id);
  if (existing) clearTimeout(existing);
  if (immediate) {
    pendingSave.delete(job.id);
    void writeJob(job).catch((e) => console.warn(`[jobs] 저장 실패: ${e instanceof Error ? e.message : e}`));
    return;
  }
  const t = setTimeout(() => {
    pendingSave.delete(job.id);
    void writeJob(job).catch((e) => console.warn(`[jobs] 저장 실패: ${e instanceof Error ? e.message : e}`));
  }, 1500);
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
      allowDirect: v.allowDirect === true,
      unityPath: typeof v.unityPath === "string" ? v.unityPath : undefined,
      unityMcpPort: typeof v.unityMcpPort === "number" ? v.unityMcpPort : undefined,
      setupCommand: typeof v.setupCommand === "string" ? v.setupCommand : undefined,
    };
  }
  return out;
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
// 제출 · 취소
// ---------------------------------------------------------------------------

export interface SubmitJobOptions {
  project: string;
  prompt: string;
  title?: string;
  mode?: JobMode;
  skipPermissions?: boolean;
  /** 완료 웹훅 링크 생성에 쓸 보드 포트 */
  port?: number;
}

export async function submitJob(opts: SubmitJobOptions): Promise<Job> {
  await ensureLoaded();
  const projects = await loadProjects();
  const cfg = projects[opts.project];
  if (!cfg) throw new Error(`알 수 없는 프로젝트: ${opts.project} (등록: ${Object.keys(projects).join(", ") || "없음"})`);
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("prompt가 비어 있습니다");
  const mode: JobMode = opts.mode === "direct" ? "direct" : "pr";
  if (mode === "direct" && !cfg.allowDirect) {
    throw new Error(`프로젝트 ${opts.project}는 direct 모드가 꺼져 있습니다 (projects.json allowDirect: true 필요)`);
  }

  const job: Job = {
    id: newId(),
    project: opts.project,
    title: (opts.title?.trim() || prompt.split("\n")[0]).slice(0, 80),
    prompt,
    mode,
    status: "queued",
    stage: "queued",
    createdAt: new Date().toISOString(),
    baseBranch: cfg.baseBranch,
    skipPermissions: opts.skipPermissions === true,
    log: [],
  };
  jobs.set(job.id, job);
  pushLog(job, "info", `잡 제출 (project: ${job.project}, mode: ${job.mode}, base: ${job.baseBranch})`);
  await writeJob(job);

  const port = opts.port ?? 3000;
  const prev = queues.get(job.project) ?? Promise.resolve();
  const next = prev
    .then(() => runJob(job, cfg, port))
    .catch((e) => console.warn(`[jobs] 큐 오류: ${e instanceof Error ? e.message : e}`));
  queues.set(job.project, next);
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
    const proc = procs.get(job.id);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
    scheduleSave(job, true);
    return job;
  }
  return job;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function pushLog(job: Job, kind: RunLogLine["kind"], text: string) {
  job.log.push({ ts: new Date().toISOString(), kind, text });
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

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 외부 명령 실행. 인자 배열로만 넘긴다(셸 미사용). 출력은 잡 로그에 남긴다. */
function exec(
  job: Job,
  cmd: string,
  args: string[],
  opts: { cwd: string; quiet?: boolean; shell?: boolean; env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!opts.quiet) pushLog(job, "tool", `$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.set(job.id, child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      procs.delete(job.id);
      pushLog(job, "stderr", `${cmd} 실행 실패: ${err.message}`);
      resolve({ code: null, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      procs.delete(job.id);
      const out = stdout.trim();
      const err = stderr.trim();
      if (!opts.quiet) {
        if (out) pushLog(job, "info", out.slice(-1500));
        if (err) pushLog(job, code === 0 ? "info" : "stderr", err.slice(-1500));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function git(job: Job, cwd: string, args: string[], quiet = false) {
  return exec(job, "git", args, { cwd, quiet });
}

function buildJobPrompt(job: Job, cfg: ProjectConfig, worktree: string): string {
  return `너는 원격 워커 세션이다. 아래 조건에서 작업하라.

- 프로젝트: ${job.project}
- 작업 디렉터리(worktree): ${worktree}
- 현재 브랜치: ${job.branch} (기준: ${job.baseBranch})
- 결과 처리 모드: ${job.mode === "pr" ? "PR 생성" : `${job.baseBranch}에 직접 반영`}

## 지시
${job.prompt}

## 마무리 규칙 (필수)
- 작업이 끝나면 변경 사항을 커밋한다. 커밋 메시지는 이 프로젝트의 CLAUDE.md 커밋 규칙을 따른다.
- **push 하지 않는다.** push·PR 생성은 워커가 처리한다.
- 브랜치를 바꾸거나 worktree 밖의 경로를 수정하지 않는다.
- 마지막 응답에 수행한 작업·검증 결과·남은 문제를 짧게 요약한다.`;
}

async function runClaude(job: Job, cfg: ProjectConfig, worktree: string): Promise<boolean> {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (job.skipPermissions) args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits");
  pushLog(job, "info", `claude ${args.join(" ")}  (cwd: ${worktree})`);

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: worktree,
      shell: process.platform === "win32",
      env: process.env,
    });
    procs.set(job.id, child);
    child.stdin.write(buildJobPrompt(job, cfg, worktree));
    child.stdin.end();

    let resultOk: boolean | undefined;
    const parser = createLineParser((ev) => {
      if (ev.resultOk !== undefined) resultOk = ev.resultOk;
      pushLog(job, ev.kind, ev.text);
    });
    child.stdout.on("data", (c: Buffer) => parser.push(c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => {
      const t = c.toString("utf8").trim();
      if (t) pushLog(job, "stderr", t.slice(0, 1000));
    });
    child.on("error", (err) => {
      procs.delete(job.id);
      pushLog(job, "stderr", `claude CLI 실행 실패: ${err.message} — claude가 PATH에 있는지 확인하세요.`);
      resolve(false);
    });
    child.on("close", (code) => {
      procs.delete(job.id);
      parser.flush();
      pushLog(job, "info", `claude 종료 (exit ${code})`);
      resolve(code === 0 && resultOk !== false);
    });
  });
}

async function runJob(job: Job, cfg: ProjectConfig, port: number): Promise<void> {
  if (isCancelled(job)) return;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.branch = `agent/${job.id.slice(0, 8)}`;
  const worktree = path.join(WORKTREE_ROOT, `${job.project}-${job.id.slice(0, 8)}`);
  job.worktree = worktree;
  scheduleSave(job, true);

  const repo = cfg.path;
  const base = job.baseBranch;
  let pushed = false;

  try {
    // 1. worktree
    setStage(job, "worktree");
    await fs.mkdir(WORKTREE_ROOT, { recursive: true });
    const fetched = await git(job, repo, ["fetch", "origin", base]);
    const startPoint = fetched.code === 0 ? `origin/${base}` : base;
    if (fetched.code !== 0) pushLog(job, "info", `origin fetch 실패 — 로컬 ${base}에서 분기합니다`);
    const wt = await git(job, repo, ["worktree", "add", "-b", job.branch, worktree, startPoint]);
    if (wt.code !== 0) throw new Error(`worktree 생성 실패 (exit ${wt.code})`);
    if (cfg.setupCommand) {
      const setup = await exec(job, cfg.setupCommand, [], { cwd: worktree, shell: true });
      if (setup.code !== 0) throw new Error(`setupCommand 실패 (exit ${setup.code})`);
    }
    if (isCancelled(job)) return;

    // 2. claude
    setStage(job, "claude");
    const ok = await runClaude(job, cfg, worktree);
    if (isCancelled(job)) return;
    if (!ok) throw new Error("claude 세션이 실패로 끝났습니다 — 로그를 확인하세요");

    // 3. commit (에이전트가 커밋을 안 했으면 워커가 대신)
    setStage(job, "commit");
    const status = await git(job, worktree, ["status", "--porcelain"], true);
    if (status.stdout.trim()) {
      await git(job, worktree, ["add", "-A"]);
      const commit = await git(job, worktree, ["commit", "-m", `에이전트 - ${job.title}`]);
      if (commit.code !== 0) throw new Error("커밋 실패");
    }
    const count = await git(job, worktree, ["rev-list", "--count", `${startPoint}..HEAD`], true);
    job.commitCount = Number(count.stdout.trim()) || 0;
    scheduleSave(job, true);
    if (job.commitCount === 0) {
      pushLog(job, "info", "변경 사항 없음 — push/PR을 건너뜁니다");
      finish(job, "succeeded");
      return;
    }

    // 4. verify (Unity 배치모드 컴파일 — projects.json에 unityPath가 있을 때만)
    if (cfg.unityPath && UNITY_VERIFY) {
      setStage(job, "verify");
      const isUnity = await fs
        .stat(path.join(worktree, "ProjectSettings", "ProjectVersion.txt"))
        .then(() => true)
        .catch(() => false);
      if (isUnity) {
        const logFile = path.join(DATA_DIR, `${job.id}-unity.log`);
        pushLog(job, "info", `Unity 배치모드 컴파일 검증 시작 (로그: ${logFile}) — 첫 임포트는 수 분 걸릴 수 있음`);
        const unity = await exec(
          job,
          cfg.unityPath,
          ["-batchmode", "-nographics", "-quit", "-projectPath", worktree, "-logFile", logFile],
          { cwd: worktree, quiet: true }
        );
        if (isCancelled(job)) return;
        if (unity.code !== 0) {
          const tail = await fs.readFile(logFile, "utf8").then((t) => t.slice(-2000)).catch(() => "");
          if (tail) pushLog(job, "stderr", tail);
          throw new Error(`Unity 컴파일 검증 실패 (exit ${unity.code}) — worktree를 남겨 두었습니다`);
        }
        pushLog(job, "info", "Unity 컴파일 검증 통과");
      } else {
        pushLog(job, "info", "Unity 프로젝트가 아니라 검증을 건너뜁니다");
      }
    }
    if (isCancelled(job)) return;

    // 5. push
    setStage(job, "push");
    if (job.mode === "pr") {
      const push = await git(job, worktree, ["push", "-u", "origin", job.branch]);
      if (push.code !== 0) throw new Error("브랜치 push 실패");
      pushed = true;

      // 6. PR
      setStage(job, "pr");
      const body = `자동 생성 — 원격 워커 잡 ${job.id}\n\n## 지시\n${job.prompt}\n\n## 세션 요약\n${lastResult(job)}`;
      const pr = await exec(
        job,
        "gh",
        ["pr", "create", "--base", base, "--head", job.branch, "--title", job.title, "--body", body],
        { cwd: worktree }
      );
      if (pr.code !== 0) throw new Error("PR 생성 실패 — 브랜치는 push됐습니다 (gh auth 상태 확인)");
      const url = pr.stdout.trim().split("\n").find((l) => l.startsWith("https://"));
      if (url) job.prUrl = url;
    } else {
      // direct: 최신 base 위로 rebase 후 fast-forward push
      const refetch = await git(job, worktree, ["fetch", "origin", base]);
      if (refetch.code === 0) {
        const rebase = await git(job, worktree, ["rebase", `origin/${base}`]);
        if (rebase.code !== 0) {
          await git(job, worktree, ["rebase", "--abort"], true);
          throw new Error(`origin/${base} 위로 rebase 실패 — 충돌을 수동으로 해결해야 합니다 (worktree 유지)`);
        }
      }
      const push = await git(job, worktree, ["push", "origin", `HEAD:${base}`]);
      if (push.code !== 0) throw new Error(`${base} push 실패`);
      pushed = true;
    }

    // 7. cleanup
    setStage(job, "cleanup");
    if (!KEEP_WORKTREE) {
      await git(job, repo, ["worktree", "remove", "--force", worktree]);
      if (job.mode === "direct") await git(job, repo, ["branch", "-D", job.branch], true);
    }
    finish(job, "succeeded");
  } catch (e) {
    if (isCancelled(job)) {
      finish(job, "cancelled", `취소됨 (${job.stage} 단계)`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      finish(job, "failed", pushed ? `${msg} (브랜치 ${job.branch}는 push됨)` : msg);
    }
  } finally {
    // try 안에서 취소를 감지해 return한 경우 — 아직 종료 처리가 안 됐으면 여기서 마감
    if (isCancelled(job) && !job.endedAt) {
      finish(job, "cancelled", `취소됨 (${job.stage} 단계)`);
    }
    await git(job, repo, ["worktree", "prune"], true);
    void notifyJobFinished(job, port);
  }
}

function lastResult(job: Job): string {
  const r = [...job.log].reverse().find((l) => l.kind === "result");
  return r?.text ?? "(요약 없음)";
}
