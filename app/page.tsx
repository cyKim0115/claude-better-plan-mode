"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface PlanSummary {
  id: string;
  title: string;
  goal: string;
  workdir: string;
  revision: number;
  updatedAt: string;
  taskCount: number;
  doneCount: number;
}

export default function HomePage() {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [goal, setGoal] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/plans").then((r) => r.json()).then(setPlans).catch(() => {});
  }, []);

  async function createPlan() {
    if (!goal.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, workdir, async: true }),
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
        <div style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="대상 프로젝트 경로 (예: C:\Users\me\repo\my-project) — 실행(착수)에 필요"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            disabled={creating}
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={createPlan} disabled={creating || !goal.trim()}>
            {creating ? <><span className="spinner" /> 시작 중…</> : "플랜 생성"}
          </button>
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
              <div className="muted small">{p.workdir || "(작업 경로 미지정)"} · {new Date(p.updatedAt).toLocaleString()}</div>
            </div>
            <button className="tiny danger" onClick={() => removePlan(p.id)}>삭제</button>
          </div>
        ))}
      </div>
    </div>
  );
}
