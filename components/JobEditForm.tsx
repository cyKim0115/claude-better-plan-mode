"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_EFFORTS, type JobEffort, type JobMode } from "@/lib/types";
import { MODEL_PRESETS } from "./options";
import ProjectDirectToggle from "./ProjectDirectToggle";
import type { JobContext } from "./job-context";

/**
 * 대기 중(queued) 잡의 제출 옵션 수정.
 * 실행이 시작되면 서버가 거부하므로, 저장 실패는 "이미 시작됨"으로 안내한다.
 */
export default function JobEditForm({
  ctx,
  allowDirect,
  unityVerify,
  captureAvailable,
}: {
  ctx: JobContext;
  allowDirect: boolean;
  unityVerify: boolean;
  captureAvailable: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(ctx.title);
  const [prompt, setPrompt] = useState(ctx.prompt);
  const [mode, setMode] = useState<JobMode>(ctx.mode);
  const [model, setModel] = useState(ctx.model ?? "");
  const [effort, setEffort] = useState<string>(ctx.effort ?? "");
  const [skipVerify, setSkipVerify] = useState(ctx.skipVerify === true);
  const [capture, setCapture] = useState(ctx.capture === true);
  const [directAllowed, setDirectAllowed] = useState(allowDirect);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPlanJob = Boolean(ctx.planId);
  const editable = ctx.status === "queued";

  async function save() {
    if (!editable) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${ctx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          prompt: isPlanJob ? undefined : prompt,
          mode,
          model,
          effort,
          skipVerify,
          capture,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "수정 실패");
      router.push(`/jobs/${ctx.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div>
      <a href={`/jobs/${ctx.id}`} className="small muted">← 잡으로</a>
      <h1 style={{ marginTop: 4 }}>대기 중 잡 수정</h1>
      <p className="muted">
        아직 시작하지 않은 잡의 제출 옵션을 고칩니다. 큐에서 실행이 시작되면 더 이상 수정할 수 없습니다.
      </p>

      {!editable ? (
        <div className="error-box">
          이 잡은 이미 {ctx.status} 상태라 수정할 수 없습니다.
          {ctx.status !== "running" && (
            <div style={{ marginTop: 8 }}>
              <button className="tiny" onClick={() => router.push(`/jobs/${ctx.id}/new-session`)}>
                새 세션으로 다시 시작
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="row small muted" style={{ marginBottom: 8 }}>
            <span>{ctx.project}</span>
            <span>· base {ctx.baseBranch}</span>
            <span>· job {ctx.id.slice(0, 8)}</span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <input type="text" placeholder="제목" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
          </div>
          {isPlanJob ? (
            <div className="small muted">
              플랜 착수 잡이라 지시문은 계획표에서 조립됩니다 — 여기서는 실행 옵션만 고칩니다.
            </div>
          ) : (
            <textarea
              placeholder="워커 세션에 줄 지시"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save();
              }}
              rows={8}
              disabled={saving}
            />
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <select value={mode} onChange={(e) => setMode(e.target.value as JobMode)} disabled={saving}>
              <option value="pr">PR 생성</option>
              <option value="direct" disabled={!directAllowed}>
                {ctx.baseBranch} 직푸시{directAllowed ? "" : " (잠김)"}
              </option>
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={saving} title="모델">
              {[...(MODEL_PRESETS.includes(model) ? [] : [model]), ...MODEL_PRESETS].map((m) => (
                <option key={m} value={m}>{m ? `모델: ${m}` : "모델: 기본"}</option>
              ))}
            </select>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={saving} title="추론 레벨">
              <option value="">effort: 기본</option>
              {JOB_EFFORTS.map((ef: JobEffort) => (
                <option key={ef} value={ef}>effort: {ef}</option>
              ))}
            </select>
            {unityVerify && (
              <label className="small muted" style={{ cursor: "pointer" }} title="Unity 배치모드 컴파일 검증을 이 잡에서만 건너뜁니다">
                <input type="checkbox" checked={skipVerify} onChange={(e) => setSkipVerify(e.target.checked)} disabled={saving} />{" "}
                Unity 검증 생략
              </label>
            )}
            {captureAvailable && (
              <label
                className="small muted"
                style={{ cursor: "pointer" }}
                title="검증 뒤 에디터를 GUI로 띄워 스크린샷·녹화를 남깁니다 (배치모드로는 화면이 안 나옵니다)"
              >
                <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} disabled={saving} />{" "}
                화면 캡처
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <ProjectDirectToggle
              project={ctx.project}
              baseBranch={ctx.baseBranch}
              allowDirect={directAllowed}
              disabled={saving}
              onChanged={(next) => {
                setDirectAllowed(next);
                if (!next) setMode("pr");
              }}
            />
          </div>
          {capture && (
            <div className="small muted" style={{ marginTop: 6 }}>
              캡처 단계에서는 워커 PC에 Unity 에디터 창이 뜹니다. 그동안 그 PC를 쓰고 있다면 방해될 수 있습니다.
            </div>
          )}
          {mode === "direct" && skipVerify && (
            <div className="small" style={{ color: "var(--amber)", marginTop: 6 }}>
              검증을 생략한 채 {ctx.baseBranch}에 바로 push됩니다. 컴파일 확인은 세션 지시문에 맡기게 됩니다.
            </div>
          )}
          <div className="row spread" style={{ marginTop: 10 }}>
            <button className="primary" onClick={save} disabled={saving || !title.trim() || (!isPlanJob && !prompt.trim())}>
              {saving ? <><span className="spinner" /> 저장 중…</> : "저장"}
            </button>
            <span className="small muted">저장하면 큐 순서는 그대로 두고 옵션만 바뀝니다</span>
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
    </div>
  );
}
