"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Plan, PlanComment, PlanTask, RunLogLine, TaskStatus } from "@/lib/types";

interface RunView {
  id: string;
  status: string;
  taskIds: string[];
  startedAt: string;
  endedAt?: string;
  logLength: number;
}

const ACTIVE_RUN_STATUSES = ["starting", "running"];

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

  // 서버에서 진행 중인 run (다른 탭에서 착수했거나 새로고침한 경우도 잡힌다)
  const liveRun = runs.find((r) => ACTIVE_RUN_STATUSES.includes(r.status)) ?? null;

  // 실행/생성 중에는 2초, 아니면 10초 간격으로 갱신.
  // 느린 폴링이 있어야 MCP나 다른 탭에서 착수한 run도 보드가 알아챈다.
  const busy = Boolean(activeRunId || liveRun || plan?.generating);
  useEffect(() => {
    const t = setInterval(load, busy ? 2000 : 10000);
    return () => clearInterval(t);
  }, [busy, load]);

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

  // 사이드 진행 패널이 볼 run — 진행 중인 것 우선, 없으면 가장 최근 run
  const focusRun = runs.find((r) => r.id === activeRunId) ?? liveRun ?? runs[0] ?? null;

  return (
    <div className="board-layout">
      <div className="board-main">
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

      <aside className="board-rail">
        {focusRun ? (
          <RunProgress
            run={focusRun}
            tasks={focusRun.taskIds.map((id) => taskById.get(id)).filter((t): t is PlanTask => Boolean(t))}
          />
        ) : (
          <div className="card progress-card">
            <div className="progress-head">진행 현황</div>
            <p className="muted small" style={{ margin: 0 }}>
              태스크를 착수하면 여기에서 진행 상황을 볼 수 있습니다.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

/** 착수 후 진행 현황 — 어떤 태스크가 끝났고 지금 무엇을 하고 있는지 한눈에 */
function RunProgress({ run, tasks }: { run: RunView; tasks: PlanTask[] }) {
  const live = ACTIVE_RUN_STATUSES.includes(run.status);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { done: 0, failed: 0, running: 0, queued: 0, other: 0 };
    for (const t of tasks) {
      if (t.status in c) c[t.status] += 1;
      else c.other += 1;
    }
    return c;
  }, [tasks]);

  const total = tasks.length;
  const settled = counts.done + counts.failed;
  const percent = total === 0 ? 0 : Math.round((settled / total) * 100);

  const endedMs = run.endedAt ? +new Date(run.endedAt) : now;
  const elapsedSec = Math.max(0, Math.round((endedMs - +new Date(run.startedAt)) / 1000));
  const elapsed = elapsedSec < 60 ? `${elapsedSec}초` : `${Math.floor(elapsedSec / 60)}분 ${elapsedSec % 60}초`;

  const badgeClass = run.status === "succeeded" ? "done" : run.status === "failed" ? "failed" : "running";

  return (
    <div className="card progress-card">
      <div className="row spread">
        <span className="progress-head">진행 현황</span>
        <span className={`badge ${badgeClass}`}>
          {live && <span className="spinner" style={{ marginRight: 6 }} />}
          {run.status}
        </span>
      </div>

      <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span className="progress-fill done" style={{ width: `${total === 0 ? 0 : (counts.done / total) * 100}%` }} />
        <span className="progress-fill failed" style={{ width: `${total === 0 ? 0 : (counts.failed / total) * 100}%` }} />
      </div>

      <div className="row spread small">
        <span>
          <strong>{settled}</strong> / {total} 완료 ({percent}%)
        </span>
        <span className="muted">{elapsed}</span>
      </div>

      <div className="progress-tasks">
        {tasks.map((t, i) => (
          <div key={t.id} className={`progress-task ${t.status}`}>
            <span className="progress-dot" aria-hidden="true">
              {t.status === "running" ? <span className="spinner tiny-spinner" /> : statusMark(t.status)}
            </span>
            <span className="progress-task-title" title={t.title}>
              {i + 1}. {t.title}
            </span>
          </div>
        ))}
      </div>

      <div className="row small muted" style={{ gap: 10 }}>
        <span>Run {run.id.slice(0, 8)}</span>
        {counts.failed > 0 && <span style={{ color: "var(--red)" }}>실패 {counts.failed}</span>}
        {counts.queued > 0 && <span>대기 {counts.queued}</span>}
      </div>
    </div>
  );
}

function statusMark(status: TaskStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✕";
  if (status === "queued") return "·";
  if (status === "skipped") return "–";
  return "·";
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
    <div className={`task ${checked ? "selected" : ""} ${task.status}`}>
      <div className="task-head">
        <input type="checkbox" checked={checked} onChange={onToggle} disabled={!executable} title={executable ? "착수 대상으로 선택" : "이미 처리된 태스크"} />
        <div className="grow">
          <div className="row spread">
            <span className="task-title">{task.title}</span>
            <span className={`badge ${task.status}`}>
              {task.status === "running" && <span className="spinner" style={{ marginRight: 6 }} />}
              {task.status}
            </span>
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
        if (stopped) return; // 정리된 뒤 도착한 응답은 버린다 (StrictMode 중복 append 방지)
        if (res.status === 404) {
          // 서버 재시작 등으로 인메모리 기록이 사라진 경우
          setStatus("expired");
          doneRef.current = true;
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (stopped) return;
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
