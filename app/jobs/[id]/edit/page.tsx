import { getJob, loadProjects } from "@/lib/jobs";
import JobEditForm from "@/components/JobEditForm";
import { toJobContext } from "@/components/job-context";
import type { ProjectConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function JobEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id).catch(() => null);
  if (!job) return <div className="error-box">잡을 찾을 수 없습니다: {id}</div>;
  const projects = await loadProjects().catch(() => ({}) as Record<string, ProjectConfig>);
  const cfg = projects[job.project];
  return (
    <JobEditForm
      ctx={toJobContext(job)}
      allowDirect={cfg?.allowDirect !== false}
      unityVerify={Boolean(cfg?.unityPath)}
      captureAvailable={Boolean(cfg?.unityPath && cfg?.captureMethod)}
    />
  );
}
