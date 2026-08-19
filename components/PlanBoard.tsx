"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan, PlanComment, PlanTask, RunLogLine } from "@/lib/types";

interface RunView {
  id: string;
  status: string;
  taskIds: string[];
  startedAt: string;
  endedAt?: string;
  logLength: number;
}

export default function PlanBoard({ planId }: { planId: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [skipPerms, setSkipPerms] = useState(false);
  const [planComment, setPlanComment] = useState("");
  const defaultsAppliedRef = useRef(false);

  const load = useCallback(async (applyDefaults = false) => {
    const res = await fetch(`/api/plans/${planId}`);
    if (!res.ok) return;
    const data = await res.json();
    setPlan(data.plan);
    setRuns(data.runs ?? []);
    // 착수 가능한(pending) 태스크는 기본 체크 상태로 시작
    if ((applyDefaults || !defaultsAppliedRef.current) && data.plan && !data.plan.generating) {
      defaultsAppliedRef.current = true;
      setSelected(new Set((data.plan.tasks as PlanTask[]).filter((t) => t.status === "pending").map((t) => t.id)));
    }
  }, [planId]);

  useEffect(() => { load(); }, [load]);

  // 실행 중이거나 플랜 생성 중이면 주기적으로 갱신
  useEffect(() => {
    if (!activeRunId && !plan?.generating) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [activeRunId, plan?.generating, load]);

  const openComments = plan?.comments.filter((c) => !c.resolved) ?? [];

  async function addComment(taskId: string | null, text: string) {
    if (!text.trim()) return;
    const res = await fetch(`/api/plans/${planId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, text }),
    });
    if (res.ok) setPlan(await res.json());
  }

  async function deleteComment(commentId: string) {
    const res = await fetch(`/api/plans/${planId}/comments?commentId=${commentId}`, { method: "DELETE" });
    if (res.ok) setPlan(await res.json());
  }

  async function revise() {
    setRevising(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/revise`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "반영 실패");
      setPlan(data);
      // 개정된 계획에서도 pending 태스크는 기본 체크
      setSelected(new Set(((data.tasks ?? []) as PlanTask[]).filter((t) => t.status === "pending").map((t) => t.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevising(false);
    }
  }

  async function execute() {
    if (selected.size === 0) return;
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [...selected], skipPermissions: skipPerms }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "착수 실패");
      setActiveRunId(data.runId);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggle(taskId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  if (!plan) return <p className="muted">불러오는 중…</p>;

  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));

  return (
    <div>
      <div className="row spread">
        <div>
          <h1>{plan.title}</h1>
          <div className="row small muted">
            <span className="badge rev">rev {plan.revision}</span>
            <span>{plan.workdir || "(작업 경로 미지정)"}</span>
          </div>
        </div>
      </div>

      {plan.generating && (
        <div className="overview">
          <span className="spinner" style={{ marginRight: 8 }} />
          Claude가 계획을 생성하는 중입니다… (코드베이스 크기에 따라 수 분 걸릴 수 있어요. 완료되면 자동으로 나타납니다.)
        </div>
      )}
      {plan.generateError && <div className="error-box">플랜 생성 실패: {plan.generateError}</div>}

      {plan.overview && <div className="overview">{plan.overview}</div>}

      <details className="history">
        <summary>수정 이력 ({plan.history.length})</summary>
        {plan.history.slice().reverse().map((h) => (
          <div key={h.revision} className="history-entry">
            rev {h.revision} · {new Date(h.at).toLocaleString()} — {h.summary}
          </div>
        ))}
      </details>

      {error && <div className="error-box">{error}</div>}

      <h2>계획</h2>
      {plan.phases.map((phase) => (
        <div key={phase.id} className="phase">
          <p className="phase-title">{phase.title}</p>
          {phase.taskIds.map((tid) => {
            const t = taskById.get(tid);
            if (!t) return null;
            return (
              <TaskCard
                key={t.id}
                task={t}
                depTitles={t.dependsOn.map((d) => taskById.get(d)?.title ?? "?")}
                comments={plan.comments.filter((c) => c.taskId === t.id)}
                checked={selected.has(t.id)}
                onToggle={() => toggle(t.id)}
                onComment={(text) => addComment(t.id, text)}
                onDeleteComment={deleteComment}
              />
            );
          })}
        </div>
      ))}

      <h2>플랜 전체 코멘트</h2>
      <div className="card">
        {plan.comments.filter((c) => c.taskId === null).map((c) => (
          <CommentView key={c.id} comment={c} onDelete={() => deleteComment(c.id)} />
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <input
            type="text"
            className="grow"
            placeholder="계획 전반에 대한 첨언… (예: 테스트 태스크를 각 단계마다 넣어줘)"
            value={planComment}
            onChange={(e) => setPlanComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { addComment(null, planComment); setPlanComment(""); }
            }}
          />
          <button className="tiny" onClick={() => { addComment(null, planComment); setPlanComment(""); }}>추가</button>
        </div>
      </div>

      <div className="actionbar">
        <button className="primary" onClick={revise} disabled={revising || openComments.length === 0 || plan.generating}>
          {revising ? <><span className="spinner" /> 반영 중…</> : `코멘트 ${openComments.length}건 계획에 반영`}
        </button>
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
        <button className="primary" onClick={execute} disabled={selected.size === 0 || revising || plan.generating}>
          선택한 {selected.size}개 태스크 착수 ▶
        </button>
        <label className="row small muted" style={{ gap: 4 }}>
          <input type="checkbox" checked={skipPerms} onChange={(e) => setSkipPerms(e.target.checked)} />
          권한 확인 생략 (--dangerously-skip-permissions)
        </label>
      </div>

      <h2>실행</h2>
      {runs.length === 0 && !activeRunId && <p className="muted">아직 실행 기록이 없습니다.</p>}
      {(activeRunId ? [activeRunId, ...runs.map((r) => r.id).filter((id) => id !== activeRunId)] : runs.map((r) => r.id))
        .slice(0, 5)
        .map((rid) => (
          <RunPanel key={rid} runId={rid} onFinished={() => { setActiveRunId(null); load(true); }} />
        ))}
    </div>
  );
}

function TaskCard({
  task, depTitles, comments, checked, onToggle, onComment, onDeleteComment,
}: {
  task: PlanTask;
  depTitles: string[];
  comments: PlanComment[];
  checked: boolean;
  onToggle: () => void;
  onComment: (text: string) => void;
  onDeleteComment: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const executable = task.status === "pending" || task.status === "failed";

  function submit() {
    if (!text.trim()) return;
    onComment(text);
    setText("");
  }

  return (
    <div className={`task ${checked ? "selected" : ""} ${task.status === "running" ? "running" : ""}`}>
      <div className="task-head">
        <input type="checkbox" checked={checked} onChange={onToggle} disabled={!executable} title={executable ? "착수 대상으로 선택" : "이미 처리된 태스크"} />
        <div className="grow">
          <div className="row spread">
            <span className="task-title">{task.title}</span>
            <span className={`badge ${task.status}`}>{task.status}</span>
          </div>
          <p className="task-desc">{task.description}</p>
          <div className="task-meta">
            {task.files.map((f) => <span key={f} className="file-chip">{f}</span>)}
            {depTitles.length > 0 && <span className="badge">⤷ 선행: {depTitles.join(", ")}</span>}
            <button className="tiny" onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? "지시문 접기" : "실행 지시문 보기"}</button>
          </div>
          {showPrompt && <div className="log" style={{ marginTop: 8, maxHeight: 180 }}>{task.prompt}</div>}

          {comments.map((c) => (
            <CommentView key={c.id} comment={c} onDelete={() => onDeleteComment(c.id)} />
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="text"
              className="grow"
              placeholder="이 태스크에 코멘트/첨언…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
            <button className="tiny" onClick={submit}>추가</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentView({ comment, onDelete }: { comment: PlanComment; onDelete: () => void }) {
  return (
    <div className={`comment ${comment.resolved ? "resolved" : ""}`}>
      <div className="who">
        {comment.author} · {new Date(comment.createdAt).toLocaleString()}
        {comment.resolved && ` · rev ${comment.resolvedInRevision}에 반영됨`}
        {!comment.resolved && <button className="tiny danger" style={{ marginLeft: 8 }} onClick={onDelete}>삭제</button>}
      </div>
      {comment.text}
    </div>
  );
}

function RunPanel({ runId, onFinished }: { runId: string; onFinished: () => void }) {
  const [status, setStatus] = useState<string>("…");
  const [log, setLog] = useState<RunLogLine[]>([]);
  const cursorRef = useRef(0);
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      if (stopped) return;
      try {
        const res = await fetch(`/api/runs/${runId}?since=${cursorRef.current}`);
        if (res.status === 404) {
          // 서버 재시작 등으로 인메모리 기록이 사라진 경우
          setStatus("expired");
          doneRef.current = true;
          return;
        }
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (data.log.length > 0) {
            setLog((prev) => [...prev, ...data.log]);
            cursorRef.current = data.logLength;
          }
          const finished = ["succeeded", "failed", "cancelled"].includes(data.status);
          if (finished && !doneRef.current) {
            doneRef.current = true;
            onFinished();
            return; // 폴링 종료
          }
        }
      } catch { /* 서버 재시작 등 — 다음 폴링에서 재시도 */ }
      if (!stopped && !doneRef.current) setTimeout(poll, 1500);
    }
    poll();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [log]);

  const badgeClass = status === "succeeded" ? "done" : status === "failed" ? "failed" : "running";

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row spread" style={{ marginBottom: 8 }}>
        <strong className="small">Run {runId.slice(0, 8)}</strong>
        <span className={`badge ${badgeClass}`}>
          {(status === "running" || status === "starting") && <span className="spinner" style={{ marginRight: 6 }} />}
          {status}
        </span>
      </div>
      <div className="log" ref={boxRef}>
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
