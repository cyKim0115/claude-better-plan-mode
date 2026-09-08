"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Job, RunLogLine } from "@/lib/types";
import { ago, statusBadge } from "./JobList";

type JobMeta = Omit<Job, "log"> & { logLength: number; log: RunLogLine[] };

export default function JobView({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [meta, setMeta] = useState<Omit<JobMeta, "log"> | null>(null);
  const [log, setLog] = useState<RunLogLine[]>([]);
  const [missing, setMissing] = useState(false);
  const cursorRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      if (stopped) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}?since=${cursorRef.current}`);
        if (stopped) return;
        if (res.status === 404) {
          setMissing(true);
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as JobMeta;
          if (stopped) return;
          const { log: newLines, ...rest } = data;
          setMeta(rest);
          if (newLines.length > 0) {
            setLog((prev) => [...prev, ...newLines]);
            cursorRef.current = data.logLength;
          }
          if (["succeeded", "failed", "cancelled"].includes(data.status)) return;
        }
      } catch {
        /* 서버 재시작 등 — 다음 폴링에서 재시도 */
      }
      if (!stopped) setTimeout(poll, 1500);
    }
    poll();
    return () => {
      stopped = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (autoScroll) boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [log, autoScroll]);

  const [actionError, setActionError] = useState<string | null>(null);

  async function cancel() {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  }

  async function resume(skipVerify: boolean) {
    setActionError(null);
    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipVerify }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionError(data.error ?? "재개 실패");
      return;
    }
    // 재개하면 로그가 이어 붙으므로 폴링을 다시 시작한다
    window.location.reload();
  }

  if (missing) return <div className="error-box">잡을 찾을 수 없습니다: {jobId}</div>;
  if (!meta) return <p className="muted">불러오는 중…</p>;

  const active = meta.status === "queued" || meta.status === "running";
  const worktreeAlive = Boolean(meta.worktree) && !meta.worktreeRemovedAt;
  // 커밋 단계부터 다시 도는 재개 (claude는 다시 돌지 않는다)
  const resumable = !active && worktreeAlive && meta.status !== "succeeded";
  // 세션을 이어 추가 지시 (claude --resume) — 성공한 잡도 worktree만 남아 있으면 가능
  const continuable = !active && worktreeAlive;

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 8 }}>
        <div>
          <a href="/jobs" className="small muted">← 잡 목록</a>
          <h1 style={{ marginTop: 4 }}>{meta.title}</h1>
          <div className="row small muted">
            <span>{meta.project}</span>
            <span>· {meta.mode === "pr" ? "PR 생성" : `${meta.baseBranch} 직푸시`}</span>
            {meta.branch && <span>· {meta.branch}</span>}
            {meta.model && <span>· 모델 {meta.model}</span>}
            {meta.effort && <span>· effort {meta.effort}</span>}
            {meta.verify && <span>· 검증 {meta.verify}</span>}
            {meta.followUpCount ? <span>· 이어서 {meta.followUpCount}회</span> : null}
            {meta.parentJobId && (
              <a href={`/jobs/${meta.parentJobId}`}>· 이전 잡 {meta.parentJobId.slice(0, 8)}</a>
            )}
            <span>· job {meta.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="row">
          {meta.status === "running" && <span className="small muted">마지막 활동 {ago(meta.lastActivityAt)}</span>}
          <span className={`badge ${statusBadge(meta.status)}`}>
            {meta.status === "running" && <span className="spinner" style={{ marginRight: 6 }} />}
            {meta.status} · {meta.stage}
          </span>
          {active && <button className="danger tiny" onClick={cancel}>취소</button>}
          {!active && (
            <>
              <button
                className="tiny"
                onClick={() => router.push(`/jobs/${jobId}/continue`)}
                disabled={!continuable}
                title={
                  continuable
                    ? "이전 세션을 그대로 이어 추가 지시 (claude --resume)"
                    : "worktree가 남아 있지 않아 이어서할 수 없습니다 — 새 세션으로 시작하세요"
                }
              >
                이어서하기
              </button>
              <button
                className="tiny"
                onClick={() => router.push(`/jobs/${jobId}/new-session`)}
                title="이 잡의 지시·요약을 컨텍스트로 참조하는 새 세션"
              >
                새 세션
              </button>
            </>
          )}
          {resumable && (
            <>
              <button className="tiny" onClick={() => resume(false)} title="claude 없이 커밋 → push/PR만 마무리">
                커밋부터 마무리
              </button>
              <button className="tiny" onClick={() => resume(true)} title="Unity 검증 없이 push/PR까지">검증 없이 마무리</button>
            </>
          )}
        </div>
      </div>
      {actionError && <div className="error-box">{actionError}</div>}

      {(meta.prUrl || meta.error || meta.worktree) && (
        <div className="card" style={{ marginBottom: 10 }}>
          {meta.prUrl && (
            <div>PR: <a href={meta.prUrl} target="_blank" rel="noreferrer">{meta.prUrl}</a></div>
          )}
          {meta.commitCount !== undefined && <div className="small muted">커밋 {meta.commitCount}개</div>}
          {meta.worktree && (
            <div className="small muted">
              worktree: {meta.worktree}
              {meta.worktreeRemovedAt ? " (정리됨)" : ""}
            </div>
          )}
          {meta.error && <div style={{ color: "var(--red)", marginTop: 6 }}>{meta.error}</div>}
        </div>
      )}

      <details className="card" style={{ marginBottom: 10 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>지시문 보기</summary>
        <div className="log" style={{ marginTop: 8, maxHeight: 220 }}>{meta.prompt}</div>
      </details>

      <div className="row spread" style={{ marginBottom: 6 }}>
        <strong className="small">로그</strong>
        <label className="small muted" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> 자동 스크롤
        </label>
      </div>
      <div className="log" ref={boxRef} style={{ maxHeight: "60vh" }}>
        {log.length === 0 && <span className="muted">로그 대기 중…</span>}
        {log.map((l, i) => (
          <div key={i} className={`log-line ${l.kind}`}>
            <span className="k">[{l.kind}]</span>{l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
