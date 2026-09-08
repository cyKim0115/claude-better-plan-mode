"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_EFFORTS, type JobEffort } from "@/lib/types";
import { MODEL_PRESETS } from "./options";
import JobContextCard from "./JobContextCard";
import { canFollowUp, type JobContext } from "./job-context";

/**
 * 이어서하기 — 이전 claude 세션을 그대로 이어(--resume) 추가 지시를 수행한다.
 * worktree·브랜치·PR을 그대로 쓰므로 결과는 같은 브랜치(있으면 같은 PR)에 쌓인다.
 */
export default function JobFollowUpForm({ ctx, unityVerify }: { ctx: JobContext; unityVerify: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [asNewJob, setAsNewJob] = useState(false);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState(ctx.model ?? "");
  const [effort, setEffort] = useState<string>(ctx.effort ?? "");
  const [skipVerify, setSkipVerify] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gate = canFollowUp(ctx);

  async function submit() {
    if (!prompt.trim() || !gate.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${ctx.id}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          asNewJob,
          title: asNewJob && title.trim() ? title : undefined,
          model: model || undefined,
          effort: effort || undefined,
          skipVerify,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "이어서하기 실패");
      router.push(`/jobs/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <a href={`/jobs/${ctx.id}`} className="small muted">← 잡으로</a>
      <h1 style={{ marginTop: 4 }}>이어서하기</h1>
      <p className="muted">
        이전 세션을 그대로 이어 추가 지시를 수행합니다. worktree·브랜치를 그대로 쓰므로 결과는 같은 브랜치
        {ctx.prUrl ? "(같은 PR)" : ""}에 쌓입니다.
      </p>

      <JobContextCard ctx={ctx} />

      {!gate.ok ? (
        <div className="error-box">
          이어서할 수 없습니다: {gate.reason}
          <div style={{ marginTop: 8 }}>
            <button className="tiny" onClick={() => router.push(`/jobs/${ctx.id}/new-session`)}>
              새 세션으로 시작
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="small muted" style={{ marginBottom: 8 }}>
            {ctx.hasSession
              ? "이전 세션 id로 재개합니다 (claude --resume)."
              : "세션 id가 기록되기 전 잡입니다 — 이 worktree의 최근 대화를 이어갑니다 (claude --continue)."}
            {ctx.followUpCount ? ` · 지금까지 ${ctx.followUpCount}회 이어서 실행` : ""}
          </div>
          <textarea
            placeholder="추가 지시. 예: 방금 만든 팝업에 닫기 애니메이션 추가하고 컴파일까지 확인"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            }}
            rows={5}
            disabled={submitting}
            autoFocus
          />
          <div className="row" style={{ marginTop: 10 }}>
            <select
              value={asNewJob ? "new" : "same"}
              onChange={(e) => setAsNewJob(e.target.value === "new")}
              disabled={submitting}
              title="기록 방식"
            >
              <option value="same">기록: 이 잡에 이어붙이기</option>
              <option value="new">기록: 새 잡 카드로 분리</option>
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={submitting} title="모델">
              {MODEL_PRESETS.map((m) => (
                <option key={m} value={m}>{m ? `모델: ${m}` : "모델: 기본"}</option>
              ))}
            </select>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={submitting} title="추론 레벨">
              <option value="">effort: 기본</option>
              {JOB_EFFORTS.map((ef: JobEffort) => (
                <option key={ef} value={ef}>effort: {ef}</option>
              ))}
            </select>
            {unityVerify && (
              <label className="small muted" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={skipVerify} onChange={(e) => setSkipVerify(e.target.checked)} disabled={submitting} />{" "}
                Unity 검증 생략
              </label>
            )}
          </div>
          {asNewJob && (
            <div style={{ marginTop: 8 }}>
              <input
                type="text"
                placeholder="새 잡 제목 (비우면 추가 지시 첫 줄)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={submitting}
              />
            </div>
          )}
          <div className="row spread" style={{ marginTop: 10 }}>
            <button className="primary" onClick={submit} disabled={submitting || !prompt.trim()}>
              {submitting ? <><span className="spinner" /> 제출 중…</> : "이어서 실행"}
            </button>
            <span className="small muted">
              {asNewJob
                ? `새 잡이 ${ctx.branch}·세션을 이어받습니다`
                : `이 잡(${ctx.id.slice(0, 8)})의 로그에 이어서 쌓입니다`}
            </span>
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
    </div>
  );
}
