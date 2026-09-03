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
  /** claude -p에 전달할 지시문 */
  prompt: string;
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
  prUrl?: string;
  /** 이번 잡이 base 대비 만든 커밋 수 */
  commitCount?: number;
  /** 실패 사유 */
  error?: string;
  /** true면 --dangerously-skip-permissions (기본 acceptEdits) */
  skipPermissions?: boolean;
  log: RunLogLine[];
}

/** projects.json 항목 */
export interface ProjectConfig {
  /** 메인 clone 절대경로 (worktree의 기준 리포) */
  path: string;
  /** 기본 브랜치 (master / main) */
  baseBranch: string;
  /** direct 모드 허용 여부 — 기본 false */
  allowDirect?: boolean;
  /** Unity 프로젝트면 배치모드 컴파일 검증에 쓸 Unity 실행 파일 경로 (없으면 검증 생략) */
  unityPath?: string;
  /** 참고용 — 이 프로젝트의 unity-mcp 브리지 포트 */
  unityMcpPort?: number;
  /** worktree 생성 후 실행할 셸 명령 (예: 의존성 설치) */
  setupCommand?: string;
}
