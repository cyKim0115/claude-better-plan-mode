"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobEffort } from "@/lib/types";
import { MODEL_PRESETS } from "@/components/options";

interface PlanSummary {
  id: string;
  title: string;
  goal: string;
  workdir: string;
  project?: string;
  revision: number;
  updatedAt: string;
  taskCount: number;
  doneCount: number;
}

interface ProjectSummary {
  key: string;
  baseBranch: string;
  allowDirect: boolean;
  unityVerify: boolean;
  defaultModel?: string;
  defaultEffort?: JobEffort;
}

export default function HomePage() {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [efforts, setEfforts] = useState<JobEffort[]>([]);
  const [goal, setGoal] = useState("");
  const [project, setProject] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/plans").then((r) => r.json()).then(setPlans).catch(() => {});
    fetch("/api/jobs")
      .then((r) => r.json())
      .then((d: { projects: ProjectSummary[]; efforts: JobEffort[] }) => {
        setProjects(d.projects ?? []);
        setEfforts(d.efforts ?? []);
        setProject((p) => p || d.projects?.[0]?.key || "");
      })
      .catch(() => {});
  }, []);

  const current = projects.find((p) => p.key === project);

  async function createPlan() {
    if (!goal.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          project: project || undefined,
          workdir: project ? undefined : workdir,
          model: model || undefined,
          effort: effort || undefined,
          async: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "플랜 생성 실패");
      router.push(`/plan/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  async function removePlan(id: string) {
    await fetch(`/api/plans/${id}`, { method: "DELETE" });
    setPlans((p) => p.filter((x) => x.id !== id));
  }

  return (
    <div>
      <h1>새 플랜</h1>
      <p className="muted">목표를 적으면 Claude가 코드베이스를 탐색해 실행 계획을 세웁니다.</p>

      <div className="card" style={{ marginTop: 12 }}>
        <textarea
          placeholder="목표를 설명하세요. 예: 로그인 기능에 OAuth를 추가하고 테스트까지 작성"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          disabled={creating}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <select value={project} onChange={(e) => setProject(e.target.value)} disabled={creating} title="대상 프로젝트">
            {projects.map((p) => (
              <option key={p.key} value={p.key}>{p.key}</option>
            ))}
            <option value="">직접 경로 입력 (PR/직푸시 없음)</option>
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={creating} title="계획 생성 모델">
            {MODEL_PRESETS.map((m) => (
              <option key={m} value={m}>{m ? `계획 모델: ${m}` : "계획 모델: 기본"}</option>
            ))}
          </select>
          <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={creating} title="계획 추론 레벨">
            <option value="">계획 effort: 기본</option>
            {efforts.map((ef) => (
              <option key={ef} value={ef}>계획 effort: {ef}</option>
            ))}
          </select>
        </div>
        {!project && (
          <div style={{ marginTop: 8 }}>
            <input
              type="text"
              placeholder="대상 프로젝트 경로 (예: C:\Users\me\repo\my-project) — 실행(착수)에 필요"
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
              disabled={creating}
            />
          </div>
        )}
        <div className="row spread" style={{ marginTop: 10 }}>
          <button className="primary" onClick={createPlan} disabled={creating || !goal.trim()}>
            {creating ? <><span className="spinner" /> 시작 중…</> : "플랜 생성"}
          </button>
          <span className="small muted">
            {current
              ? `${current.baseBranch} 기준 · 직푸시 ${current.allowDirect ? "허용" : "잠김"} · Unity 검증 ${current.unityVerify ? "켜짐" : "없음"}`
              : projects.length === 0
                ? "config/projects.json이 없어 경로 입력만 가능합니다"
                : "경로만 지정하면 착수 시 PR·직푸시를 쓸 수 없습니다"}
          </span>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      <h2>플랜 목록</h2>
      <div className="plan-list">
        {plans.length === 0 && <p className="muted">아직 플랜이 없습니다.</p>}
        {plans.map((p) => (
          <div key={p.id} className="card row spread">
            <div className="grow" style={{ cursor: "pointer" }} onClick={() => router.push(`/plan/${p.id}`)}>
              <div className="row">
                <strong>{p.title}</strong>
                <span className="badge rev">rev {p.revision}</span>
                <span className="badge">{p.doneCount}/{p.taskCount} 완료</span>
              </div>
              <div className="muted small">{p.goal.slice(0, 120)}</div>
              <div className="muted small">
                {p.project ? `${p.project} · ` : ""}{p.workdir || "(작업 경로 미지정)"} · {new Date(p.updatedAt).toLocaleString()}
              </div>
            </div>
            <button className="tiny danger" onClick={() => removePlan(p.id)}>삭제</button>
          </div>
        ))}
      </div>
    </div>
  );
}
