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
