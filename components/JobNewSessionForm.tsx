"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_EFFORTS, type JobEffort, type JobMode } from "@/lib/types";
import { MODEL_PRESETS } from "./options";
import JobContextCard from "./JobContextCard";
import ProjectDirectToggle from "./ProjectDirectToggle";
import type { JobContext } from "./job-context";

/**
 * 새 세션 만들기 — 이전 잡의 지시·결과 요약을 컨텍스트로 붙여 새 잡을 제출한다.
 * 세션은 새로 시작하고(대화는 물려받지 않는다), 코드 시작점은 폼에서 고른다.
 */
export default function JobNewSessionForm({
  ctx,
  allowDirect,
  unityVerify,
}: {
  ctx: JobContext;
  allowDirect: boolean;
  unityVerify: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [startFrom, setStartFrom] = useState<"base" | "parent">(ctx.branch ? "parent" : "base");
  const [mode, setMode] = useState<JobMode>(allowDirect ? ctx.mode : "pr");
  const [directAllowed, setDirectAllowed] = useState(allowDirect);
  const [model, setModel] = useState(ctx.model ?? "");
  const [effort, setEffort] = useState<string>(ctx.effort ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: ctx.project,
          prompt,
          title: title.trim() || undefined,
          mode,
          model: model || undefined,
          effort: effort || undefined,
          parentJobId: ctx.id,
          startFrom,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "잡 제출 실패");
      router.push(`/jobs/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <a href={`/jobs/${ctx.id}`} className="small muted">← 잡으로</a>
      <h1 style={{ marginTop: 4 }}>새 세션 만들기</h1>
      <p className="muted">
        이전 잡의 지시와 세션 요약을 컨텍스트로 붙여 새 세션을 시작합니다. 대화는 물려받지 않으므로, 이어서 다듬는
        작업이면 <a href={`/jobs/${ctx.id}/continue`}>이어서하기</a>가 더 정확합니다.
      </p>

      <JobContextCard ctx={ctx} />

      <div className="card">
        <textarea
          placeholder="새 세션에 줄 지시. 예: PR 리뷰에서 지적된 널 체크 누락을 고치고 테스트 추가"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
          rows={5}
          disabled={submitting}
          autoFocus
        />
        <div style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="제목 (비우면 지시 첫 줄)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <select
            value={startFrom}
            onChange={(e) => setStartFrom(e.target.value as "base" | "parent")}
            disabled={submitting || !ctx.branch}
            title="worktree 시작점"
          >
            <option value="parent" disabled={!ctx.branch}>
              시작점: 이전 브랜치 {ctx.branch ?? "(없음)"} 위
            </option>
            <option value="base">시작점: {ctx.baseBranch}에서 새로</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as JobMode)} disabled={submitting}>
            <option value="pr">PR 생성</option>
            <option value="direct" disabled={!directAllowed}>
              {ctx.baseBranch} 직푸시{directAllowed ? "" : " (잠김)"}
            </option>
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
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <ProjectDirectToggle
            project={ctx.project}
            baseBranch={ctx.baseBranch}
            allowDirect={directAllowed}
            disabled={submitting}
            onChanged={(next) => {
              setDirectAllowed(next);
              if (!next) setMode("pr");
            }}
          />
        </div>

        <div className="small muted" style={{ marginTop: 8 }}>
          {startFrom === "parent"
            ? `새 worktree를 ${ctx.branch} 위에서 만들고, 새 브랜치로 갈라져 나갑니다 — 이전 변경이 코드에 이미 들어 있습니다.`
            : `새 worktree를 ${ctx.baseBranch}에서 만듭니다 — 이전 변경은 코드에 없고, 프롬프트 컨텍스트로만 참조합니다.`}
          {unityVerify ? " · Unity 컴파일 검증이 걸립니다." : ""}
        </div>
        {startFrom === "parent" && mode === "direct" && (
          <div className="small" style={{ color: "var(--amber)", marginTop: 6 }}>
            직푸시를 고르면 이전 브랜치의 커밋까지 {ctx.baseBranch}에 함께 올라갑니다. 이전 작업을 아직 머지하지 않았다면 PR 모드를 쓰세요.
          </div>
        )}

        <div className="row spread" style={{ marginTop: 10 }}>
          <button className="primary" onClick={submit} disabled={submitting || !prompt.trim()}>
            {submitting ? <><span className="spinner" /> 제출 중…</> : "새 세션 시작"}
          </button>
          <span className="small muted">프로젝트 {ctx.project} · base {ctx.baseBranch}</span>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}
