"use client";

import { useState } from "react";

/**
 * 프로젝트의 직푸시 허용(config/projects.json의 allowDirect)을 보드에서 켜고 끈다.
 * 기본 브랜치에 바로 push하는 설정이라, 켜는 순간 확인 문구를 한 번 띄운다.
 */
export default function ProjectDirectToggle({
  project,
  baseBranch,
  allowDirect,
  disabled,
  onChanged,
}: {
  project: string;
  baseBranch: string;
  allowDirect: boolean;
  disabled?: boolean;
  onChanged: (allowDirect: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (next && !window.confirm(`${project}의 ${baseBranch} 직푸시를 허용할까요?\n에이전트가 PR 없이 ${baseBranch}에 바로 push할 수 있게 됩니다.`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowDirect: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "설정 변경 실패");
      onChanged(data.allowDirect === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      <label
        className="small muted"
        style={{ cursor: saving || disabled ? "default" : "pointer" }}
        title="config/projects.json의 allowDirect를 바꿉니다"
      >
        <input
          type="checkbox"
          checked={allowDirect}
          disabled={saving || disabled}
          onChange={(e) => void toggle(e.target.checked)}
        />{" "}
        {baseBranch} 직푸시 허용
      </label>
      {saving && <span className="spinner" />}
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
    </span>
  );
}
