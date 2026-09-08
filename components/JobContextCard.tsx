"use client";

import type { JobContext } from "./job-context";

/** 이어서하기·새 세션 폼 위에 붙는 이전 잡 요약 카드 */
export default function JobContextCard({ ctx }: { ctx: JobContext }) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row spread">
        <strong>{ctx.title}</strong>
        <a className="small muted" href={`/jobs/${ctx.id}`}>잡 상세 →</a>
      </div>
      <div className="row small muted" style={{ marginTop: 4 }}>
        <span>{ctx.project}</span>
        <span>· {ctx.status} / {ctx.stage}</span>
        <span>· {ctx.mode === "pr" ? "PR 생성" : `${ctx.baseBranch} 직푸시`}</span>
        {ctx.branch && <span>· {ctx.branch}</span>}
        {ctx.commitCount !== undefined && <span>· 커밋 {ctx.commitCount}개</span>}
        {ctx.verify && <span>· 검증 {ctx.verify}</span>}
        {ctx.model && <span>· {ctx.model}</span>}
        {ctx.effort && <span>· effort {ctx.effort}</span>}
      </div>
      {ctx.prUrl && (
        <div className="small" style={{ marginTop: 6 }}>
          PR: <a href={ctx.prUrl} target="_blank" rel="noreferrer">{ctx.prUrl}</a>
        </div>
      )}
      {ctx.error && <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>{ctx.error}</div>}
      <details style={{ marginTop: 8 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>이전 지시 · 세션 요약 보기</summary>
        <div className="small muted" style={{ marginTop: 8 }}>지시</div>
        <div className="log" style={{ marginTop: 4, maxHeight: 200 }}>{ctx.prompt}</div>
        <div className="small muted" style={{ marginTop: 8 }}>세션 요약</div>
        <div className="log" style={{ marginTop: 4, maxHeight: 240 }}>{ctx.resultSummary}</div>
      </details>
    </div>
  );
}
