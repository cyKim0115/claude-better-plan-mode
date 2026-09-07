// 외부 프로세스 실행 공용 유틸.
//
// - 자식을 프로세스 그룹 리더로 띄운다 (claude·Unity가 낳은 손자까지 한 번에 종료).
// - 워치독(전체 상한 + 무출력 정지)이 반드시 붙는다 — 조용히 멈춘 프로세스는 없다.
// - 잡 실행(lib/jobs.ts)과 워크트리 정리(lib/worktree-gc.ts)가 이 한 구현을 공유한다.
//   새 스폰을 추가할 때 여기를 우회하지 않는다.

import { spawn, type ChildProcess } from "child_process";

/** 프로세스 그룹으로 띄울 수 있는 플랫폼인지 (윈도우는 불가) */
export const DETACH = process.platform !== "win32";

export function signalTree(proc: ChildProcess, sig: NodeJS.Signals) {
  if (!proc.pid) return;
  try {
    if (DETACH) process.kill(-proc.pid, sig);
    else proc.kill(sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* 이미 죽음 */
    }
  }
}

/** SIGTERM 후 유예 시간이 지나도 살아 있으면 SIGKILL */
export function killTree(proc: ChildProcess, graceMs = 10_000) {
  signalTree(proc, "SIGTERM");
  const t = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) signalTree(proc, "SIGKILL");
  }, graceMs);
  t.unref?.();
}

/**
 * exit 이후 stdio가 닫히길 기다리되 상한을 둔다.
 * 손자 프로세스가 파이프를 물고 있으면 'close'가 영영 안 오므로, exit 후 짧게만 기다린다.
 */
function settleOnExit(child: ChildProcess, onDone: (code: number | null) => void) {
  let done = false;
  let exitCode: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    onDone(exitCode);
  };
  child.on("exit", (code) => {
    exitCode = code;
    timer = setTimeout(finish, 3_000);
    timer.unref?.();
  });
  child.on("close", (code) => {
    exitCode = code ?? exitCode;
    finish();
  });
}

export type WatchdogReason = "timeout" | "stall";

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 워치독이 죽였으면 사유 */
  killed?: WatchdogReason;
  /** spawn 자체가 실패했으면 그 메시지 (명령이 없는 경우 등) */
  spawnError?: string;
}

export interface ProcOptions {
  cwd: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 전체 상한 */
  timeoutMs?: number;
  /** 이 시간 동안 stdout/stderr가 없으면 정지로 판정 */
  stallMs?: number;
  /** stdin으로 넣고 닫을 내용 (claude -p 지시문 등) */
  input?: string;
  /** 스폰 직후 자식 핸들 — 취소용 레지스트리에 등록할 때 쓴다 */
  onSpawn?: (child: ChildProcess) => void;
  /** stdout/stderr 청크 콜백 (스트리밍 파싱·활동 시각 갱신용) */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** 워치독이 프로세스를 죽이기 직전 호출 */
  onWatchdog?: (reason: WatchdogReason, limitMs: number) => void;
}

/** 버퍼 상한 — 넘으면 앞부분을 버린다 (원격 잡 로그가 메모리를 먹지 않게) */
const BUFFER_MAX = 200_000;
const BUFFER_KEEP = 100_000;

/**
 * 인자 배열로만 명령을 실행한다 (shell: true는 설정 파일에서 온 setupCommand 전용).
 * 예외를 던지지 않는다 — 실패도 ProcResult로 돌려준다.
 */
export function spawnWatched(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: DETACH,
    });
    opts.onSpawn?.(child);

    if (opts.input !== undefined && child.stdin) {
      // 자식이 먼저 죽으면 EPIPE가 뜬다 — 잡을 죽일 이유는 아니다
      child.stdin.on("error", () => undefined);
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let lastActivity = Date.now();
    const startedAt = Date.now();
    let killed: WatchdogReason | undefined;

    const watchdog = setInterval(() => {
      const now = Date.now();
      let limitMs = 0;
      if (opts.timeoutMs && now - startedAt > opts.timeoutMs) {
        killed = "timeout";
        limitMs = opts.timeoutMs;
      } else if (opts.stallMs && now - lastActivity > opts.stallMs) {
        killed = "stall";
        limitMs = opts.stallMs;
      }
      if (killed) {
        clearInterval(watchdog);
        opts.onWatchdog?.(killed, limitMs);
        killTree(child);
      }
    }, 5_000);
    watchdog.unref?.();

    child.stdout?.on("data", (c: Buffer) => {
      lastActivity = Date.now();
      const s = c.toString("utf8");
      stdout += s;
      if (stdout.length > BUFFER_MAX) stdout = stdout.slice(-BUFFER_KEEP);
      opts.onStdout?.(s);
    });
    child.stderr?.on("data", (c: Buffer) => {
      lastActivity = Date.now();
      const s = c.toString("utf8");
      stderr += s;
      if (stderr.length > BUFFER_MAX) stderr = stderr.slice(-BUFFER_KEEP);
      opts.onStderr?.(s);
    });

    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ code: null, stdout, stderr: stderr + err.message, killed, spawnError: err.message });
    });
    settleOnExit(child, (code) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ code, stdout, stderr, killed });
    });
  });
}
