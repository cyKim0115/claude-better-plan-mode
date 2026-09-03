"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobMode, JobStatus } from "@/lib/types";

interface JobSummary {
  id: string;
  project: string;
  title: string;
  mode: JobMode;
  status: JobStatus;
  stage: string;
  createdAt: string;
  endedAt?: string;
  branch?: string;
  prUrl?: string;
  error?: string;
}

export function statusBadge(status: JobStatus): string {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "cancelled") return "skipped";
  return "queued";
}

export default function JobList() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<JobMode>("pr");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = (await res.json()) as { projects: string[]; jobs: JobSummary[] };
      setJobs(data.jobs);
      setProjects(data.projects);
      setProject((p) => p || data.projects[0] || "");
    } catch {
      /* 다음 폴링에서 재시도 */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function submit() {
    if (!project || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, prompt, title: title || undefined, mode }),
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
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as JobMode)} disabled={submitting}>
            <option value="pr">PR 생성</option>
            <option value="direct">기본 브랜치 직푸시</option>
          </select>
          <input
            type="text"
            className="grow"
            placeholder="제목 (비우면 지시 첫 줄)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            style={{ width: "auto", flex: 1 }}
          />
        </div>
        <textarea
          placeholder="워커 세션에 줄 지시. 예: 로비 팝업에 닫기 버튼 추가하고 컴파일 확인"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          disabled={submitting}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={submit} disabled={submitting || !project || !prompt.trim()}>
            {submitting ? <><span className="spinner" /> 제출 중…</> : "잡 제출"}
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

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
              <span className="muted small">{j.project} · {j.mode} · {j.stage}</span>
            </div>
            <div className="row small muted">
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
