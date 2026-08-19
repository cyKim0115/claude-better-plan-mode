import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Plan, PlanComment, PlanPhase, PlanTask } from "./types";
import { newId } from "./store";

/** Agent SDK 응답에서 최종 텍스트를 뽑는다 */
async function runAgent(prompt: string, workdir?: string): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd: workdir && workdir.trim() ? workdir : undefined,
      // 플랜 단계에서는 읽기 전용 탐색만 허용
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch"],
      permissionMode: "default",
      maxTurns: 30,
    },
  });

  let resultText = "";
  for await (const message of q) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        throw new Error(`agent ended: ${message.subtype}`);
      }
    }
  }
  if (!resultText) throw new Error("agent returned no result");
  return resultText;
}

/** 응답 텍스트에서 JSON 오브젝트를 최대한 관대하게 추출 */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in agent output");
  return JSON.parse(candidate.slice(start, end + 1));
}

interface RawTask {
  id?: string;
  title?: string;
  description?: string;
  files?: string[];
  dependsOn?: string[];
  prompt?: string;
}
interface RawPhase {
  title?: string;
  taskIds?: string[];
}
interface RawPlan {
  title?: string;
  overview?: string;
  phases?: RawPhase[];
  tasks?: RawTask[];
}

const PLAN_SCHEMA_INSTRUCTIONS = `
반드시 아래 스키마의 JSON 하나만 \`\`\`json 코드펜스로 출력하라. 다른 산문은 코드펜스 밖에 짧게만.

{
  "title": "플랜 한 줄 제목",
  "overview": "접근 방식 요약 (몇 문장)",
  "tasks": [
    {
      "id": "t1",
      "title": "태스크 제목",
      "description": "무엇을 왜 하는지",
      "files": ["관련 파일/디렉토리 경로"],
      "dependsOn": ["선행 태스크 id"],
      "prompt": "이 태스크만 단독 실행할 때 Claude Code에 줄 완결된 지시문 (필요 컨텍스트 포함)"
    }
  ],
  "phases": [
    { "title": "Phase 1: ...", "taskIds": ["t1", "t2"] }
  ]
}

규칙:
- 태스크는 독립적으로 착수 가능한 단위로 쪼갤 것 (보통 4~12개)
- prompt는 그 태스크만 떼어 실행해도 되도록 자기완결적으로 쓸 것
- 모든 task id는 어떤 phase에든 속해야 함
`;

function normalizePlanShape(raw: RawPlan, existing?: Plan): { title: string; overview: string; phases: PlanPhase[]; tasks: PlanTask[] } {
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const idMap = new Map<string, string>();
  const prevByTitle = new Map<string, PlanTask>();
  existing?.tasks.forEach((t) => prevByTitle.set(t.title, t));

  const tasks: PlanTask[] = rawTasks.map((t, i) => {
    const rawId = t.id || `t${i + 1}`;
    const stableId = newId();
    idMap.set(rawId, stableId);
    // 제목이 같은 기존 태스크의 진행 상태는 보존
    const prev = prevByTitle.get(t.title ?? "");
    return {
      id: stableId,
      title: t.title ?? `Task ${i + 1}`,
      description: t.description ?? "",
      files: Array.isArray(t.files) ? t.files : [],
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      status: prev && (prev.status === "done" || prev.status === "failed") ? prev.status : "pending",
      prompt: t.prompt ?? t.description ?? "",
    };
  });
  // dependsOn을 새 id로 매핑
  for (const t of tasks) {
    t.dependsOn = t.dependsOn.map((d) => idMap.get(d) ?? "").filter(Boolean);
  }

  const rawPhases = Array.isArray(raw.phases) && raw.phases.length > 0 ? raw.phases : [{ title: "Phase 1", taskIds: rawTasks.map((t, i) => t.id || `t${i + 1}`) }];
  const phases: PlanPhase[] = rawPhases.map((p, i) => ({
    id: newId(),
    title: p.title ?? `Phase ${i + 1}`,
    taskIds: (Array.isArray(p.taskIds) ? p.taskIds : []).map((d) => idMap.get(d) ?? "").filter(Boolean),
  }));
  // phase에 안 들어간 태스크 수거
  const placed = new Set(phases.flatMap((p) => p.taskIds));
  const orphans = tasks.filter((t) => !placed.has(t.id)).map((t) => t.id);
  if (orphans.length > 0) phases[phases.length - 1].taskIds.push(...orphans);

  return {
    title: raw.title ?? existing?.title ?? "Untitled plan",
    overview: raw.overview ?? "",
    phases,
    tasks,
  };
}

export async function generatePlan(goal: string, workdir: string): Promise<Plan> {
  const prompt = `너는 시니어 엔지니어이자 플래너다. 아래 목표를 달성하기 위한 실행 계획을 세워라.
${workdir ? "현재 작업 디렉토리의 코드베이스를 필요한 만큼 탐색(Read/Glob/Grep)해서 현실적인 계획을 세워라." : ""}

## 목표
${goal}

${PLAN_SCHEMA_INSTRUCTIONS}`;

  const text = await runAgent(prompt, workdir);
  const raw = extractJson(text) as RawPlan;
  const shaped = normalizePlanShape(raw);
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: shaped.title,
    goal,
    workdir,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    overview: shaped.overview,
    phases: shaped.phases,
    tasks: shaped.tasks,
    comments: [],
    history: [{ revision: 1, at: now, summary: "최초 플랜 생성", appliedCommentIds: [] }],
  };
}

export async function revisePlan(plan: Plan, openComments: PlanComment[]): Promise<Plan> {
  const taskTitle = (id: string | null) => (id ? plan.tasks.find((t) => t.id === id)?.title ?? "(삭제된 태스크)" : "(플랜 전체)");
  const commentLines = openComments
    .map((c) => `- [대상: ${taskTitle(c.taskId)}] ${c.text}`)
    .join("\n");

  const planForModel = {
    title: plan.title,
    overview: plan.overview,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      files: t.files,
      dependsOn: t.dependsOn,
      status: t.status,
      prompt: t.prompt,
    })),
    phases: plan.phases.map((p) => ({ title: p.title, taskIds: p.taskIds })),
  };

  const prompt = `기존 실행 계획에 사용자의 코멘트/첨언이 달렸다. 코멘트를 충실히 반영해 계획을 수정하라.
- status가 done/failed인 태스크는 이미 실행된 것이므로 내용은 유지하되, 코멘트가 명시적으로 요구하면 후속 태스크를 추가하는 식으로 반영하라.
- 태스크 id는 기존 id를 유지하고, 새 태스크만 새 id(t_new1 등)를 붙여라.

## 원래 목표
${plan.goal}

## 현재 계획 (revision ${plan.revision})
\`\`\`json
${JSON.stringify(planForModel, null, 2)}
\`\`\`

## 반영할 코멘트
${commentLines}

${PLAN_SCHEMA_INSTRUCTIONS}
추가 규칙: 출력 JSON 최상위에 "revisionSummary": "이번 수정에서 무엇을 바꿨는지 한두 문장" 필드를 포함하라.`;

  const text = await runAgent(prompt, plan.workdir);
  const raw = extractJson(text) as RawPlan & { revisionSummary?: string };

  // 기존 id를 유지하도록: raw task id가 기존 plan의 id와 일치하면 그대로 사용
  const existingIds = new Set(plan.tasks.map((t) => t.id));
  const prevById = new Map(plan.tasks.map((t) => [t.id, t]));
  const idMap = new Map<string, string>();

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: PlanTask[] = rawTasks.map((t, i) => {
    const rawId = t.id || `t${i + 1}`;
    const keep = existingIds.has(rawId);
    const finalId = keep ? rawId : newId();
    idMap.set(rawId, finalId);
    const prev = keep ? prevById.get(rawId) : undefined;
    const status = prev && prev.status !== "pending" ? prev.status : "pending";
    return {
      id: finalId,
      title: t.title ?? prev?.title ?? `Task ${i + 1}`,
      description: t.description ?? prev?.description ?? "",
      files: Array.isArray(t.files) ? t.files : prev?.files ?? [],
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      status,
      prompt: t.prompt ?? prev?.prompt ?? "",
    };
  });
  for (const t of tasks) {
    t.dependsOn = t.dependsOn.map((d) => idMap.get(d) ?? (existingIds.has(d) ? d : "")).filter(Boolean);
  }

  const rawPhases = Array.isArray(raw.phases) && raw.phases.length > 0 ? raw.phases : [{ title: "Phase 1", taskIds: rawTasks.map((t, i) => t.id || `t${i + 1}`) }];
  const phases: PlanPhase[] = rawPhases.map((p, i) => ({
    id: newId(),
    title: p.title ?? `Phase ${i + 1}`,
    taskIds: (Array.isArray(p.taskIds) ? p.taskIds : []).map((d) => idMap.get(d) ?? (existingIds.has(d) ? d : "")).filter(Boolean),
  }));
  const placed = new Set(phases.flatMap((p) => p.taskIds));
  const orphans = tasks.filter((t) => !placed.has(t.id)).map((t) => t.id);
  if (orphans.length > 0) phases[phases.length - 1].taskIds.push(...orphans);

  const now = new Date().toISOString();
  const revision = plan.revision + 1;
  const appliedIds = openComments.map((c) => c.id);

  return {
    ...plan,
    title: raw.title ?? plan.title,
    overview: raw.overview ?? plan.overview,
    tasks,
    phases,
    revision,
    comments: plan.comments.map((c) =>
      appliedIds.includes(c.id) ? { ...c, resolved: true, resolvedInRevision: revision } : c
    ),
    history: [
      ...plan.history,
      {
        revision,
        at: now,
        summary: raw.revisionSummary ?? `코멘트 ${openComments.length}건 반영`,
        appliedCommentIds: appliedIds,
      },
    ],
  };
}
