export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed" | "skipped";

export interface PlanComment {
  id: string;
  /** null → plan 전체에 대한 코멘트, 아니면 대상 task id */
  taskId: string | null;
  author: string;
  text: string;
  createdAt: string;
  /** revise 시 반영 완료된 코멘트는 resolved 처리 */
  resolved: boolean;
  /** 반영된 revision 번호 */
  resolvedInRevision?: number;
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  /** 관련 파일/영역 힌트 */
  files: string[];
  /** 선행 태스크 id 목록 */
  dependsOn: string[];
  status: TaskStatus;
  /** 실행 시 Claude Code에 전달할 상세 지침 */
  prompt: string;
}

export interface PlanPhase {
  id: string;
  title: string;
  taskIds: string[];
}

export interface RevisionEntry {
  revision: number;
  at: string;
  summary: string;
  appliedCommentIds: string[];
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  /** 실행 대상 프로젝트의 로컬 경로 (claude CLI의 cwd) */
  workdir: string;
  /**
   * config/projects.json의 키. 지정하면 착수가 잡 파이프라인을 타고
   * PR/직푸시·Unity 검증·worktree 격리를 그 프로젝트 설정대로 쓴다.
   * 없으면 workdir에서 직접 실행하는 레거시 경로.
   */
  project?: string;
  /** 계획 생성·수정 에이전트에 쓸 모델 (생략 시 기본) */
  planModel?: string;
  /** 계획 생성·수정 에이전트의 추론 레벨 (생략 시 기본) */
  planEffort?: JobEffort;
  createdAt: string;
  updatedAt: string;
  revision: number;
  overview: string;
  phases: PlanPhase[];
  tasks: PlanTask[];
  comments: PlanComment[];
  history: RevisionEntry[];
  /** 백그라운드 생성 진행 중 (MCP 등 비동기 생성 경로) */
  generating?: boolean;
  /** 백그라운드 생성 실패 시 오류 메시지 */
  generateError?: string;
}

export type RunStatus = "starting" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunLogLine {
  ts: string;
  kind: "system" | "assistant" | "tool" | "result" | "stderr" | "info";
  text: string;
}

export interface Run {
  id: string;
  planId: string;
  taskIds: string[];
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  log: RunLogLine[];
}

// ---------------------------------------------------------------------------
// 원격 워커 잡 — 다른 PC의 에이전트가 MCP(worker)로 제출하는 작업 단위
// ---------------------------------------------------------------------------

/** pr: 전용 브랜치 push + PR 생성 / direct: 기본 브랜치에 바로 push */
export type JobMode = "pr" | "direct";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 잡이 거치는 단계 — stage 필드에 마지막으로 도달한 값이 남는다 */
export type JobStage =
  | "queued"
  | "worktree"
  | "claude"
  | "commit"
  | "verify"
  | "push"
  | "pr"
  | "cleanup"
  | "done";

export interface Job {
  id: string;
  /** config/projects.json의 키 */
  project: string;
  /** 알림·목록용 짧은 제목 */
  title: string;
  /** claude -p에 전달할 지시문. 플랜 착수 잡이면 선택한 태스크로 조립된다 */
  prompt: string;
  /** 플랜 착수로 만들어진 잡이면 그 플랜 id — 진행 마커가 이 플랜의 태스크 상태를 갱신한다 */
  planId?: string;
  /** 플랜 착수 잡이 이번에 수행할 태스크 id 목록 */
  taskIds?: string[];
  mode: JobMode;
  status: JobStatus;
  stage: JobStage;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** 기본 브랜치 (projects.json) */
  baseBranch: string;
  /** 잡 전용 브랜치 (agent/<id 앞 8자리>) */
  branch?: string;
  /** worktree 절대경로 */
  worktree?: string;
  /** worktree가 정리된 시각 (성공 후 정리 또는 GC). 있으면 job_resume 불가 */
  worktreeRemovedAt?: string;
  prUrl?: string;
  /** 이번 잡이 base 대비 만든 커밋 수 */
  commitCount?: number;
  /** 실패 사유 */
  error?: string;
  /** true면 --dangerously-skip-permissions (기본 acceptEdits + git 커밋 허용) */
  skipPermissions?: boolean;
  /** claude --model (alias 또는 전체 이름). 생략 시 워커 PC의 기본 모델 */
  model?: string;
  /** claude --effort */
  effort?: JobEffort;
  /** claude --max-turns */
  maxTurns?: number;
  /** Unity 배치모드 검증 결과. pr 모드는 실패해도 PR까지 올리고 결과를 본문·알림에 남긴다 */
  verify?: JobVerifyResult;
  /** 마지막으로 로그가 붙은 시각 — 워치독·보드의 "멈춤" 판정 기준 */
  lastActivityAt?: string;
  /** job_resume으로 이어 돌린 횟수 */
  resumeCount?: number;
  log: RunLogLine[];
}

export type JobVerifyResult = "passed" | "failed" | "timeout" | "skipped";

export type JobEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const JOB_EFFORTS: readonly JobEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** projects.json 항목 */
export interface ProjectConfig {
  /** 메인 clone 절대경로 (worktree의 기준 리포) */
  path: string;
  /** 기본 브랜치 (master / main) */
  baseBranch: string;
  /** direct 모드(기본 브랜치 직푸시) 허용 여부 — 기본 true. 잠그려면 false */
  allowDirect?: boolean;
  /** 이 프로젝트 잡의 기본 모델/추론 레벨 (job_submit에서 지정하면 그쪽이 우선) */
  defaultModel?: string;
  defaultEffort?: JobEffort;
  /** Unity 프로젝트면 배치모드 컴파일 검증에 쓸 Unity 실행 파일 경로 (없으면 검증 생략) */
  unityPath?: string;
  /** 참고용 — 이 프로젝트의 unity-mcp 브리지 포트 */
  unityMcpPort?: number;
  /** worktree 생성 후 실행할 셸 명령 (예: 의존성 설치) */
  setupCommand?: string;
  /**
   * macOS 전용. 메인 clone의 Library/를 APFS clonefile(cp -c)로 worktree에 복사해
   * Unity 첫 임포트(수십 분)를 건너뛴다. 에디터가 열린 채 복사하면 일부 캐시가 재생성될 수 있다.
   */
  seedUnityLibrary?: boolean;
}
