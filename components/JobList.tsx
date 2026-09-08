"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobEffort, JobMode, JobStatus, JobVerifyResult } from "@/lib/types";
import { MODEL_PRESETS } from "./options";
import WorktreePanel from "./WorktreePanel";
import ProjectDirectToggle from "./ProjectDirectToggle";

interface JobSummary {
  id: string;
  project: string;
  title: string;
  mode: JobMode;
  model?: string;
  effort?: JobEffort;
  status: JobStatus;
  stage: string;
  verify?: JobVerifyResult;
  createdAt: string;
  endedAt?: string;
  lastActivityAt?: string;
  branch?: string;
  prUrl?: string;
  error?: string;
  resumeCount?: number;
  followUpCount?: number;
  parentJobId?: string;
}

interface ProjectSummary {
  key: string;
  baseBranch: string;
  allowDirect: boolean;
  unityVerify: boolean;
  defaultModel?: string;
  defaultEffort?: JobEffort;
}

export function statusBadge(status: JobStatus): string {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "cancelled") return "skipped";
  return "queued";
}

export function ago(iso?: string): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분 전`;
}


export default function JobList() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [efforts, setEfforts] = useState<JobEffort[]>([]);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<JobMode>("pr");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = (await res.json()) as { projects: ProjectSummary[]; efforts: JobEffort[]; jobs: JobSummary[] };
      setJobs(data.jobs);
      setProjects(data.projects);
      setEfforts(data.efforts ?? []);
      setProject((p) => p || data.projects[0]?.key || "");
    } catch {
      /* 다음 폴링에서 재시도 */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const current = projects.find((p) => p.key === project);

  async function submit() {
    if (!project || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          prompt,
          title: title || undefined,
          mode,
          model: model || undefined,
          effort: effort || undefined,
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
      <h1>원격 워커 잡</h1>
      <p className="muted">
        다른 PC의 에이전트가 MCP로 제출한 작업이 여기 쌓입니다. 직접 제출해 볼 수도 있습니다.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <select value={project} onChange={(e) => setProject(e.target.value)} disabled={submitting}>
            {projects.length === 0 && <option value="">프로젝트 없음 — config/projects.json 확인</option>}
            {projects.map((p) => (
              <option key={p.key} value={p.key}>{p.key}</option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as JobMode)} disabled={submitting}>
            <option value="pr">PR 생성</option>
            <option value="direct" disabled={current ? !current.allowDirect : false}>
              {current?.baseBranch ?? "기본 브랜치"} 직푸시{current && !current.allowDirect ? " (잠김)" : ""}
            </option>
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={submitting} title="모델">
            {MODEL_PRESETS.map((m) => (
              <option key={m} value={m}>{m ? `모델: ${m}` : `모델: 기본${current?.defaultModel ? ` (${current.defaultModel})` : ""}`}</option>
            ))}
          </select>
          <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={submitting} title="추론 레벨">
            <option value="">effort: 기본{current?.defaultEffort ? ` (${current.defaultEffort})` : ""}</option>
            {efforts.map((ef) => (
              <option key={ef} value={ef}>effort: {ef}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            placeholder="제목 (비우면 지시 첫 줄)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
          />
        </div>
        <textarea
          placeholder="워커 세션에 줄 지시. 예: 로비 팝업에 닫기 버튼 추가하고 컴파일 확인"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          disabled={submitting}
        />
        <div className="row spread" style={{ marginTop: 10 }}>
          <button className="primary" onClick={submit} disabled={submitting || !project || !prompt.trim()}>
            {submitting ? <><span className="spinner" /> 제출 중…</> : "잡 제출"}
          </button>
          {current && (
            <span className="row">
              <span className="small muted">
                base {current.baseBranch} · Unity 검증 {current.unityVerify ? "켜짐" : "없음"}
              </span>
              <ProjectDirectToggle
                project={current.key}
                baseBranch={current.baseBranch}
                allowDirect={current.allowDirect}
                disabled={submitting}
                onChanged={(next) => {
                  setProjects((ps) => ps.map((p) => (p.key === current.key ? { ...p, allowDirect: next } : p)));
                  if (!next) setMode("pr"); // 잠그면 직푸시 선택을 남겨 두지 않는다
                }}
              />
            </span>
          )}
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      <WorktreePanel />

      <h2>잡 목록</h2>
      {jobs.length === 0 && <p className="muted">아직 잡이 없습니다.</p>}
      {jobs.map((j) => (
        <div key={j.id} className="card" style={{ marginBottom: 8 }}>
          <div className="row spread">
            <div className="row">
              <span className={`badge ${statusBadge(j.status)}`}>
                {j.status === "running" && <span className="spinner" style={{ marginRight: 6 }} />}
                {j.status}
              </span>
              <a href={`/jobs/${j.id}`}><strong>{j.title}</strong></a>
              <span className="muted small">
                {j.project} · {j.mode} · {j.stage}
                {j.model ? ` · ${j.model}` : ""}{j.effort ? ` · ${j.effort}` : ""}
                {j.verify && j.verify !== "skipped" ? ` · 검증 ${j.verify}` : ""}
                {j.resumeCount ? ` · 재개 ${j.resumeCount}회` : ""}
                {j.followUpCount ? ` · 이어서 ${j.followUpCount}회` : ""}
                {j.parentJobId ? " · 이어받음" : ""}
              </span>
            </div>
            <div className="row small muted">
              {j.status === "running" && <span>활동 {ago(j.lastActivityAt)}</span>}
              {j.prUrl && <a href={j.prUrl} target="_blank" rel="noreferrer">PR</a>}
              <span>{new Date(j.createdAt).toLocaleString("ko-KR")}</span>
            </div>
          </div>
          {j.error && <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>{j.error}</div>}
        </div>
      ))}
    </div>
  );
}
