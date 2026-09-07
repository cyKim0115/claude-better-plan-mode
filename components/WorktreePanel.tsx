"use client";

import { useCallback, useState } from "react";

interface Entry {
  path: string;
  project: string | null;
  jobId?: string;
  jobStatus?: string;
  branch?: string;
  ageHours: number;
  unsaved: boolean;
  orphan: boolean;
  sizeKb?: number;
  action: "removed" | "kept" | "failed";
  reason: string;
}

interface Scan {
  at: string;
  dryRun: boolean;
  worktreeRoot: string;
  ttlHours: number;
  unsavedTtlHours: number;
  worktrees: Entry[];
  removedLocalBranches: string[];
  removedRemoteBranches: string[];
  freedKb: number;
  errors: string[];
}

function size(kb?: number): string {
  if (!kb) return "";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}MB`;
  return `${kb}KB`;
}

/** 워커가 남긴 worktree 현황과 즉시 정리. 평소에는 서버가 보관 기한에 맞춰 알아서 지운다. */
export default function WorktreePanel() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState<"" | "scan" | "clean">("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy("scan");
    setError(null);
    try {
      const res = await fetch("/api/worktrees?size=1");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "현황 조회 실패");
      setScan(data.scan as Scan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }, []);

  async function clean(force: boolean) {
    if (force && !confirm("보관 기한을 무시하고 지금 정리합니다. 저장 안 된 변경이 남은 worktree는 그대로 둡니다. 계속할까요?")) return;
    setBusy("clean");
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, measure: true }),
      });
      const data = (await res.json()) as Scan & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "정리 실패");
      const removed = data.worktrees.filter((w) => w.action === "removed").length;
      setNote(
        `worktree ${removed}개 정리${data.freedKb > 0 ? ` · ${size(data.freedKb)} 확보` : ""}` +
          `${data.removedLocalBranches.length ? ` · 로컬 브랜치 ${data.removedLocalBranches.length}개` : ""}` +
          `${data.removedRemoteBranches.length ? ` · 원격 브랜치 ${data.removedRemoteBranches.length}개` : ""}`
      );
      setScan(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  const total = scan?.worktrees.reduce((n, w) => n + (w.sizeKb ?? 0), 0) ?? 0;

  return (
    <details className="card" style={{ marginBottom: 12 }} onToggle={(e) => {
      if ((e.currentTarget as HTMLDetailsElement).open && !scan && busy === "") void load();
    }}>
      <summary className="small muted" style={{ cursor: "pointer" }}>
        워크트리 정리 {scan ? `— ${scan.worktrees.length}개 남음${total ? ` (${size(total)})` : ""}` : ""}
      </summary>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="tiny" onClick={() => void load()} disabled={busy !== ""}>
          {busy === "scan" ? <><span className="spinner" /> 조회 중…</> : "현황 새로고침"}
        </button>
        <button className="tiny" onClick={() => void clean(false)} disabled={busy !== ""}>
          기한 지난 것 정리
        </button>
        <button className="tiny danger" onClick={() => void clean(true)} disabled={busy !== ""}>
          지금 전부 정리
        </button>
        {busy === "clean" && <span className="small muted"><span className="spinner" /> 정리 중…</span>}
      </div>

      {note && <div className="small" style={{ marginTop: 8 }}>{note}</div>}
      {error && <div className="error-box">{error}</div>}

      {scan && (
        <div style={{ marginTop: 10 }}>
          <div className="small muted">
            {scan.worktreeRoot} · 보관 기한 {scan.ttlHours}시간 (저장 안 된 변경은 {scan.unsavedTtlHours}시간)
          </div>
          {scan.worktrees.length === 0 && <div className="small muted" style={{ marginTop: 6 }}>남은 worktree가 없습니다.</div>}
          {scan.worktrees.map((w) => (
            <div key={w.path} className="row spread small" style={{ marginTop: 6 }}>
              <div>
                <code>{w.path.split("/").pop()}</code>{" "}
                <span className="muted">
                  {w.project ?? "프로젝트 불명"}
                  {w.orphan ? " · 고아" : w.jobStatus ? ` · ${w.jobStatus}` : ""}
                  {w.unsaved ? " · 저장 안 된 변경" : ""}
                  {w.sizeKb ? ` · ${size(w.sizeKb)}` : ""}
                </span>
              </div>
              <span className="muted">
                {w.action === "removed" ? (scan.dryRun ? "정리 예정" : "정리됨") : w.action === "failed" ? "삭제 실패" : w.reason}
              </span>
            </div>
          ))}
          {scan.errors.length > 0 && (
            <div className="small" style={{ color: "var(--red)", marginTop: 8 }}>{scan.errors.join("\n")}</div>
          )}
        </div>
      )}
    </details>
  );
}
