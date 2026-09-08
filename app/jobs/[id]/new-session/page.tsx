import { getJob, loadProjects } from "@/lib/jobs";
import JobNewSessionForm from "@/components/JobNewSessionForm";
import { toJobContext } from "@/components/job-context";
import type { ProjectConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function JobNewSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id).catch(() => null);
  if (!job) return <div className="error-box">잡을 찾을 수 없습니다: {id}</div>;
  const projects = await loadProjects().catch(() => ({}) as Record<string, ProjectConfig>);
  const cfg = projects[job.project];
  return (
    <JobNewSessionForm
      ctx={toJobContext(job)}
      allowDirect={cfg?.allowDirect !== false}
      unityVerify={Boolean(cfg?.unityPath)}
    />
  );
}
