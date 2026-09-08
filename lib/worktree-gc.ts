// 워커 잡이 남긴 worktree·브랜치 정리(GC).
//
// 왜 필요한가: 잡은 일부러 흔적을 남긴다. 실패·취소·검증 실패한 잡의 worktree는 job_resume으로
// 이어서 마무리할 수 있게 남기고, pr 모드는 브랜치를 원격에 밀어 둔다. 그대로 두면 Unity Library까지
// 통째로 든 worktree가 수십 GB씩 쌓이고, 머지된 agent/* 브랜치가 로컬·원격에 계속 남는다.
// 이 모듈이 "언젠가는 반드시 지워진다"를 보장한다.
//
// 정책 (기한은 잡이 끝난 시각 또는 디렉터리 mtime 중 나중 것 기준)
// - 실행 중·대기 중 잡의 worktree는 절대 건드리지 않는다.
// - 작업물이 안전한 worktree(커밋이 없거나 브랜치가 원격에 올라감): SAFE_TTL 뒤 삭제.
// - 커밋 안 된 변경이나 push 안 된 커밋이 남은 worktree: UNSAVED_TTL(더 길게) 뒤 삭제.
//   삭제 전에 커밋된 내용은 로컬 브랜치로 남으므로, 지워지는 건 워킹트리와 빌드 산출물이다.
// - 잡과 짝이 없는 고아 디렉터리도 mtime 기준 SAFE_TTL 뒤 삭제 (WORKTREE_ROOT 안에서만).
// - 로컬 agent/* 브랜치는 worktree가 없고, 원격에 올라갔거나 base에 머지된 것만 삭제.
// - 원격 agent/* 브랜치는 PR이 머지·클로즈됐거나 base에 이미 들어간 것만 삭제.
//
// 모든 외부 명령은 lib/proc.ts의 워치독을 거친다. 삭제는 git worktree remove가 우선이고,
// 실패했을 때만 WORKTREE_ROOT 안이라는 걸 확인한 뒤 디렉터리를 지운다.

import { promises as fs } from "fs";
import path from "path";
import { spawnWatched, type ProcResult } from "./proc";
import type { Job, ProjectConfig } from "./types";

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const hours = (envName: string, fallback: number) => Math.max(1, Number(process.env[envName] || fallback)) * 3_600_000;
const minutes = (envName: string, fallback: number) => Math.max(1, Number(process.env[envName] || fallback)) * 60_000;

/** 작업물이 원격에 안전하게 올라간 worktree의 보관 기한 */
const SAFE_TTL_MS = hours("WORKER_WORKTREE_TTL_HOURS", 48);
/** 커밋·push 안 된 변경이 남은 worktree의 보관 기한 */
const UNSAVED_TTL_MS = hours("WORKER_WORKTREE_UNSAVED_TTL_HOURS", 168);
/** git / gh 한 번의 상한 */
const CMD_TIMEOUT_MS = minutes("WORKER_GIT_TIMEOUT_MIN", 10);
/** du 한 번의 상한 — 용량 계산 때문에 정리가 막히면 안 된다 */
const DU_TIMEOUT_MS = minutes("WORKER_GC_DU_TIMEOUT_MIN", 2);
/** 원격 agent/* 브랜치 정리 (0이면 로컬만 정리) */
const REMOTE_CLEANUP = process.env.WORKER_REMOTE_CLEANUP !== "0";

/** 이 GC가 손대는 브랜치 이름 — 잡이 만든 것만 (agent/ + uuid 앞 8자리) */
const AGENT_BRANCH = /^agent\/[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// 결과 모델
// ---------------------------------------------------------------------------

export type GcAction = "removed" | "kept" | "failed";

export interface GcWorktreeEntry {
  path: string;
  /** projects.json 키 — 고아 디렉터리는 이름에서 추정, 못 찾으면 null */
  project: string | null;
  jobId?: string;
  jobStatus?: Job["status"];
  branch?: string;
  /** 기준 시각으로부터 지난 시간 */
  ageHours: number;
  /** 커밋 안 된 변경이나 push 안 된 커밋이 남아 있음 */
  unsaved: boolean;
  /** 잡과 짝이 없는 디렉터리 */
  orphan: boolean;
  sizeKb?: number;
  action: GcAction;
  reason: string;
}

export interface GcResult {
  at: string;
  dryRun: boolean;
  worktreeRoot: string;
  ttlHours: number;
  unsavedTtlHours: number;
  worktrees: GcWorktreeEntry[];
  removedLocalBranches: string[];
  removedRemoteBranches: string[];
  /** 삭제한 worktree의 합계 용량 (측정에 성공한 것만) */
  freedKb: number;
  errors: string[];
}

export interface GcContext {
  jobs: Job[];
  projects: Record<string, ProjectConfig>;
  worktreeRoot: string;
  /** WORKER_KEEP_WORKTREE=1 — 사용자가 일부러 전부 남기고 있는 상태 */
  keepAll: boolean;
  /** worktree가 사라진 잡에 기록을 남긴다 (로그 + worktreeRemovedAt) */
  onWorktreeRemoved?: (job: Job, note: string) => void;
}

export interface GcOptions {
  /** 지우지 않고 대상만 계산 */
  dryRun?: boolean;
  /** 보관 기한 무시 (사용자가 즉시 정리를 요청한 경우) */
  force?: boolean;
  /** force여도 저장 안 된 변경이 남은 worktree는 기본적으로 남긴다. true면 그것까지 삭제 */
  includeUnsaved?: boolean;
  /** du로 용량을 잰다 (느릴 수 있어 목록 조회에서만 켠다) */
  measure?: boolean;
}

// ---------------------------------------------------------------------------
// 외부 명령 (전부 워치독 경유)
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string, timeoutMs = CMD_TIMEOUT_MS): Promise<ProcResult> {
  return spawnWatched(cmd, args, { cwd, timeoutMs });
}

async function git(cwd: string, args: string[]): Promise<ProcResult> {
  return run("git", args, cwd);
}

/** stdout만 필요할 때. 실패하면 빈 문자열 */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  return r.code === 0 ? r.stdout.trim() : "";
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return (await git(cwd, args)).code === 0;
}

async function duKb(dir: string): Promise<number | undefined> {
  const r = await run("du", ["-sk", dir], path.dirname(dir), DU_TIMEOUT_MS);
  const n = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// 판정 헬퍼
// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 고아 디렉터리 이름(<project>-<8자리>)에서 프로젝트 키를 되짚는다. 키에 '-'가 있을 수 있어 가장 긴 것부터 */
function guessProject(dirName: string, projects: Record<string, ProjectConfig>): string | null {
  const keys = Object.keys(projects).sort((a, b) => b.length - a.length);
  return keys.find((k) => dirName.startsWith(`${k}-`)) ?? null;
}

interface WorktreeState {
  /** 커밋 안 된 변경 또는 push 안 된 커밋이 있다 */
  unsaved: boolean;
  detail: string;
  branch?: string;
}

/**
 * worktree에 잃어버리면 안 되는 게 남았는지 본다.
 * git 명령이 통째로 실패하면(디렉터리가 이미 git worktree가 아님) 보수적으로 "안전"으로 본다 —
 * 그 경우 지울 대상은 파일 잔해뿐이고, 남겨 봐야 되살릴 방법이 없다.
 */
async function inspectWorktree(dir: string, baseBranch: string): Promise<WorktreeState> {
  const head = await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head) return { unsaved: false, detail: "git worktree가 아님" };

  const dirty = (await gitOut(dir, ["status", "--porcelain"])).length > 0;

  let unpushed = 0;
  const hasRemoteBranch = await gitOk(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${head}`]);
  const ref = hasRemoteBranch ? `origin/${head}` : `origin/${baseBranch}`;
  const counted = await gitOut(dir, ["rev-list", "--count", `${ref}..HEAD`]);
  if (counted) unpushed = Number(counted) || 0;
  else if (!hasRemoteBranch) {
    // origin/base도 없으면 로컬 base와 비교 (fetch 실패 상태에서 만든 worktree)
    unpushed = Number(await gitOut(dir, ["rev-list", "--count", `${baseBranch}..HEAD`])) || 0;
  }

  const parts: string[] = [];
  if (dirty) parts.push("커밋 안 된 변경");
  if (unpushed > 0) parts.push(`push 안 된 커밋 ${unpushed}개`);
  return { unsaved: parts.length > 0, detail: parts.join(", ") || "원격에 반영됨", branch: head };
}

/** 로컬 브랜치를 지워도 잃는 게 없는지 — 원격에 있거나 base에 머지됐으면 안전 */
async function branchIsRedundant(repo: string, branch: string, baseBranch: string): Promise<boolean> {
  const tip = await gitOut(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!tip) return false;
  if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])) {
    if (await gitOk(repo, ["merge-base", "--is-ancestor", tip, `refs/remotes/origin/${branch}`])) return true;
  }
  for (const base of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
    if (!(await gitOk(repo, ["rev-parse", "--verify", "--quiet", base]))) continue;
    if (await gitOk(repo, ["merge-base", "--is-ancestor", tip, base])) return true;
  }
  return false;
}

/** 이 리포에서 worktree가 물고 있는 브랜치들 — 지우면 안 되는 브랜치 목록 */
async function checkedOutBranches(repo: string): Promise<Set<string>> {
  const out = await gitOut(repo, ["worktree", "list", "--porcelain"]);
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^branch refs\/heads\/(.+)$/);
    if (m) set.add(m[1]);
  }
  return set;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

function isActiveJob(job: Job): boolean {
  return job.status === "running" || job.status === "queued";
}

interface Candidate {
  dir: string;
  job?: Job;
  project: string | null;
  mtimeMs: number;
}

/** WORKTREE_ROOT 바로 아래 디렉터리 + 잡이 기억하는 worktree 경로의 합집합 */
async function collectCandidates(ctx: GcContext, errors: string[]): Promise<Candidate[]> {
  // 이어서하기(새 잡 카드)로 한 worktree를 여러 잡이 공유할 수 있다.
  // 그중 실행 중·대기 중인 잡을 대표로 기억해야 아래 보호 규칙이 걸린다.
  const byPath = new Map<string, Job>();
  for (const job of ctx.jobs) {
    if (!job.worktree) continue;
    const key = path.resolve(job.worktree);
    const prev = byPath.get(key);
    if (prev && isActiveJob(prev) && !isActiveJob(job)) continue;
    byPath.set(key, job);
  }

  const found = new Map<string, Candidate>();
  const add = async (dir: string, job?: Job) => {
    const key = path.resolve(dir);
    if (found.has(key)) return;
    const st = await fs.stat(key).catch(() => null);
    if (!st?.isDirectory()) return;
    const owner = job ?? byPath.get(key);
    found.set(key, {
      dir: key,
      job: owner,
      project: owner?.project ?? guessProject(path.basename(key), ctx.projects),
      mtimeMs: st.mtimeMs,
    });
  };

  const entries = await fs.readdir(ctx.worktreeRoot, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") errors.push(`worktree 루트를 읽지 못했습니다: ${e.message}`);
    return [];
  });
  for (const e of entries) {
    if (e.isDirectory()) await add(path.join(ctx.worktreeRoot, e.name));
  }
  // 루트 밖(WORKER_WORKTREE_ROOT를 바꾼 뒤 남은 것)도 잡이 기억하고 있으면 대상에 넣는다
  for (const [p, job] of byPath) await add(p, job);

  return [...found.values()];
}

export async function collectGarbage(ctx: GcContext, opts: GcOptions = {}): Promise<GcResult> {
  const now = Date.now();
  const result: GcResult = {
    at: new Date(now).toISOString(),
    dryRun: opts.dryRun === true,
    worktreeRoot: ctx.worktreeRoot,
    ttlHours: Math.round(SAFE_TTL_MS / 3_600_000),
    unsavedTtlHours: Math.round(UNSAVED_TTL_MS / 3_600_000),
    worktrees: [],
    removedLocalBranches: [],
    removedRemoteBranches: [],
    freedKb: 0,
    errors: [],
  };

  const candidates = await collectCandidates(ctx, result.errors);
  const alive = new Set(candidates.map((c) => c.dir));

  // 이미 사라진 worktree를 기억하고 있는 잡은 기록만 맞춰 준다 (보드의 "이어서 마무리" 오해 방지)
  for (const job of ctx.jobs) {
    if (!job.worktree || job.worktreeRemovedAt) continue;
    if (isActiveJob(job)) continue;
    if (!alive.has(path.resolve(job.worktree))) ctx.onWorktreeRemoved?.(job, "디스크에 없음");
  }

  const touchedRepos = new Set<string>();

  for (const c of candidates) {
    const cfg = c.project ? ctx.projects[c.project] : undefined;
    const repo = cfg?.path;
    const job = c.job;
    const baseBranch = job?.baseBranch ?? cfg?.baseBranch ?? "main";
    const jobTime = job ? +new Date(job.endedAt ?? job.startedAt ?? job.createdAt) : 0;
    const ageMs = now - Math.max(jobTime, c.mtimeMs);
    const entry: GcWorktreeEntry = {
      path: c.dir,
      project: c.project,
      jobId: job?.id,
      jobStatus: job?.status,
      branch: job?.branch,
      ageHours: Math.round(ageMs / 3_600_000),
      unsaved: false,
      orphan: !job,
      action: "kept",
      reason: "",
    };
    result.worktrees.push(entry);

    if (job && isActiveJob(job)) {
      entry.reason = `잡이 ${job.status} 상태`;
      if (opts.measure) entry.sizeKb = await duKb(c.dir);
      continue;
    }

    const state = await inspectWorktree(c.dir, baseBranch);
    entry.unsaved = state.unsaved;
    entry.branch = job?.branch ?? state.branch;
    if (opts.measure) entry.sizeKb = await duKb(c.dir);

    if (ctx.keepAll && !opts.force) {
      entry.reason = "WORKER_KEEP_WORKTREE=1 — 즉시 정리를 요청하면 삭제";
      continue;
    }
    const ttl = state.unsaved ? UNSAVED_TTL_MS : SAFE_TTL_MS;
    if (!opts.force && ageMs < ttl) {
      const left = Math.ceil((ttl - ageMs) / 3_600_000);
      entry.reason = `보관 기한 ${Math.round(ttl / 3_600_000)}시간 중 ${left}시간 남음 (${state.detail})`;
      continue;
    }
    if (state.unsaved && opts.force && !opts.includeUnsaved) {
      entry.reason = `저장 안 된 변경이 있어 남김 (${state.detail})`;
      continue;
    }

    entry.reason = `${state.detail} · ${entry.ageHours}시간 경과`;
    if (opts.dryRun) {
      entry.action = "removed";
      if (entry.sizeKb) result.freedKb += entry.sizeKb;
      continue;
    }

    const sizeKb = entry.sizeKb ?? (await duKb(c.dir));
    const removed = await removeWorktree(c.dir, repo, ctx.worktreeRoot, result.errors);
    if (!removed) {
      entry.action = "failed";
      entry.reason = `삭제 실패 — ${entry.reason}`;
      continue;
    }
    entry.action = "removed";
    entry.sizeKb = sizeKb;
    if (sizeKb) result.freedKb += sizeKb;
    if (repo) touchedRepos.add(repo);
    if (job) ctx.onWorktreeRemoved?.(job, entry.reason);
  }

  // 브랜치 정리 — worktree를 지운 뒤라야 로컬 브랜치를 뗄 수 있다
  for (const [key, cfg] of Object.entries(ctx.projects)) {
    if (!opts.dryRun && touchedRepos.has(cfg.path)) await git(cfg.path, ["worktree", "prune"]);
    if (opts.dryRun) continue;
    await pruneLocalBranches(key, cfg, result);
    if (REMOTE_CLEANUP) await pruneRemoteBranches(key, cfg, result);
  }

  return result;
}

/** git worktree remove가 먼저. 등록이 깨졌으면 루트 안이라는 걸 확인하고 디렉터리를 지운다 */
async function removeWorktree(dir: string, repo: string | undefined, root: string, errors: string[]): Promise<boolean> {
  if (repo) {
    const r = await git(repo, ["worktree", "remove", "--force", dir]);
    if (r.code === 0) return true;
  }
  if (!isInside(root, dir)) {
    errors.push(`worktree 루트 밖이라 직접 지우지 않았습니다: ${dir}`);
    return false;
  }
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    errors.push(`디렉터리 삭제 실패 ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** worktree가 물고 있지 않고, 원격·base에 이미 반영된 로컬 agent/* 브랜치 삭제 */
async function pruneLocalBranches(key: string, cfg: ProjectConfig, result: GcResult) {
  const listed = await gitOut(cfg.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agent"]);
  if (!listed) return;
  const busy = await checkedOutBranches(cfg.path);
  for (const branch of listed.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!AGENT_BRANCH.test(branch) || busy.has(branch)) continue;
    if (!(await branchIsRedundant(cfg.path, branch, cfg.baseBranch))) continue;
    const r = await git(cfg.path, ["branch", "-D", branch]);
    if (r.code === 0) result.removedLocalBranches.push(`${key}:${branch}`);
    else result.errors.push(`${key}: 로컬 브랜치 ${branch} 삭제 실패`);
  }
}

interface RawPr {
  headRefName?: unknown;
  state?: unknown;
  url?: unknown;
}

/** PR이 머지·클로즈됐거나 base에 이미 들어간 원격 agent/* 브랜치 삭제 */
async function pruneRemoteBranches(key: string, cfg: ProjectConfig, result: GcResult) {
  const heads = await gitOut(cfg.path, ["ls-remote", "--heads", "origin", "refs/heads/agent/*"]);
  if (!heads) return;
  const branches = heads
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, "").trim() ?? "")
    .filter((b) => AGENT_BRANCH.test(b));
  if (branches.length === 0) return;

  // PR 상태는 한 번에 받아 온다 (브랜치마다 gh를 부르면 API 제한에 걸린다)
  const prState = new Map<string, string>();
  const gh = await run("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,state,url"], cfg.path);
  if (gh.code === 0) {
    try {
      const parsed = JSON.parse(gh.stdout) as unknown;
      if (Array.isArray(parsed)) {
        for (const raw of parsed as RawPr[]) {
          if (typeof raw?.headRefName === "string" && typeof raw.state === "string") {
            // 같은 브랜치로 PR이 여러 번 열렸으면 열려 있는 쪽이 이긴다
            if (prState.get(raw.headRefName) !== "OPEN") prState.set(raw.headRefName, raw.state);
          }
        }
      }
    } catch {
      result.errors.push(`${key}: gh pr list 응답을 해석하지 못했습니다 — 원격 브랜치는 건드리지 않았습니다`);
      return;
    }
  } else {
    result.errors.push(`${key}: gh pr list 실패 — 원격 브랜치는 건드리지 않았습니다 (gh auth 확인)`);
    return;
  }

  await git(cfg.path, ["fetch", "origin", cfg.baseBranch]);
  for (const branch of branches) {
    const state = prState.get(branch);
    let why: string | null = null;
    if (state === "MERGED") why = "PR 머지됨";
    else if (state === "CLOSED") why = "PR 닫힘";
    else if (state === "OPEN") continue;
    else {
      // PR 기록이 없는 브랜치 — base에 이미 들어갔을 때만 지운다
      const merged = await gitOk(cfg.path, [
        "merge-base",
        "--is-ancestor",
        `refs/remotes/origin/${branch}`,
        `refs/remotes/origin/${cfg.baseBranch}`,
      ]);
      if (!merged) continue;
      why = `${cfg.baseBranch}에 반영됨`;
    }
    const r = await git(cfg.path, ["push", "origin", "--delete", branch]);
    if (r.code === 0) result.removedRemoteBranches.push(`${key}:${branch} (${why})`);
    else result.errors.push(`${key}: 원격 브랜치 ${branch} 삭제 실패`);
  }
}

/** 알림·로그용 한 줄 요약 */
export function summarizeGc(r: GcResult): string {
  const removed = r.worktrees.filter((w) => w.action === "removed").length;
  const kept = r.worktrees.filter((w) => w.action === "kept").length;
  const parts = [`worktree ${removed}개 정리 (남김 ${kept}개)`];
  if (r.freedKb > 0) parts.push(`${formatKb(r.freedKb)} 확보`);
  if (r.removedLocalBranches.length) parts.push(`로컬 브랜치 ${r.removedLocalBranches.length}개`);
  if (r.removedRemoteBranches.length) parts.push(`원격 브랜치 ${r.removedRemoteBranches.length}개`);
  if (r.errors.length) parts.push(`오류 ${r.errors.length}건`);
  return parts.join(" · ");
}

export function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}MB`;
  return `${kb}KB`;
}
