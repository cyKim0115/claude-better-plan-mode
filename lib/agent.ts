import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JobEffort, Plan, PlanComment, PlanPhase, PlanTask } from "./types";
import { newId } from "./store";

/** 계획 에이전트 옵션 — 착수(claude CLI) 옵션과 별개로 플랜 생성·수정에만 쓰인다 */
export interface PlanAgentOptions {
  model?: string;
  effort?: JobEffort;
}

/** Agent SDK 응답에서 최종 텍스트를 뽑는다 */
async function runAgent(prompt: string, workdir?: string, agent?: PlanAgentOptions, maxTurns = 30): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd: workdir && workdir.trim() ? workdir : undefined,
      // 플랜 단계에서는 읽기 전용 탐색만 허용
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch"],
      permissionMode: "default",
      maxTurns,
      ...(agent?.model ? { model: agent.model } : {}),
      ...(agent?.effort ? { effort: agent.effort } : {}),
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

// ---------------------------------------------------------------------------
// 모델 출력 -> 플랜 JSON. 추출은 관대하게, 통과는 엄격하게.
// 태스크 prompt 안에 코드펜스나 중괄호가 섞여 들어와도 깨지지 않아야 한다
// (코드펜스를 non-greedy로 자르면 여기서 JSON이 잘려 파싱 에러가 났다).
// ---------------------------------------------------------------------------

/** 문자열 리터럴을 인식하며 균형 잡힌 최상위 { } 블록을 뽑는다 */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let closed = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closed = j;
          break;
        }
      }
    }
    // 닫히지 않았다면 나머지는 잘린 출력이다 — 후보 생성 쪽에서 따로 다룬다
    if (closed === -1) break;
    found.push(text.slice(i, closed + 1));
    i = closed + 1;
  }
  return found;
}

/** 첫 { 부터 마지막 } 까지 — 마지막 보루 */
function sliceBraces(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? "" : text.slice(start, end + 1);
}

/**
 * 모델이 자주 내는 형식 오류를 되돌린다.
 * 주석, 생략 표시(...), 문자열 안 생 줄바꿈, 트레일링·중복 콤마, 원소 사이 누락 콤마, 잘린 꼬리.
 * truncated는 "끝이 잘려서 우리가 닫아 준" 경우 — 태스크가 통째로 사라질 수 있어 그대로 받지 않는다.
 */
function repairJson(src: string): { text: string; truncated: boolean } {
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let esc = false;

  const lastChar = (): string => {
    for (let k = out.length - 1; k >= 0; k -= 1) if (!/\s/.test(out[k])) return out[k];
    return "";
  };
  // 값이 끝난 자리인지 (문자열·오브젝트·배열·숫자·true/false/null)
  const endsValue = (c: string) => /["}\]0-9]/.test(c) || c === "e" || c === "l";

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inStr = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    if (ch === "." && src[i + 1] === "." && src[i + 2] === ".") {
      i += 2;
      continue;
    }

    if (ch === ",") {
      const prev = lastChar();
      if (prev === "" || prev === "," || prev === "[" || prev === "{") continue;
      out += ch;
      continue;
    }

    if (ch === '"' || ch === "{" || ch === "[") {
      if (stack.length > 0 && endsValue(lastChar())) out += ",";
      if (ch === '"') inStr = true;
      else stack.push(ch);
      out += ch;
      continue;
    }

    if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, "");
      stack.pop();
      out += ch;
      continue;
    }

    out += ch;
  }

  const truncated = inStr || stack.length > 0;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "");
  if (/:\s*$/.test(out)) out += "null";
  while (stack.length > 0) out += stack.pop() === "{" ? "}" : "]";
  return { text: out, truncated };
}

/** 파싱 후보를 우선순위대로 만든다 (균형 스캔 -> 코드펜스 -> 통짜 슬라이스 -> 잘린 꼬리) */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    const v = value?.trim();
    if (v && v.startsWith("{") && !out.includes(v)) out.push(v);
  };
  balancedObjects(text)
    .sort((a, b) => b.length - a.length)
    .forEach(add);
  const greedy = text.match(/```(?:json)?\s*([\s\S]*)```/);
  const lazy = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const m of [greedy, lazy]) if (m) add(sliceBraces(m[1]));
  add(sliceBraces(text));
  const start = text.indexOf("{");
  if (start !== -1) add(text.slice(start));
  return out;
}

/** 스키마 최소 요건 검사 — 통과한 것만 정규화 단계로 넘긴다 */
function checkRawPlan(value: unknown): { ok: true; plan: RawPlan } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "최상위가 JSON 오브젝트가 아님" };
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) return { ok: false, reason: "tasks 배열이 없음" };
  if (obj.tasks.length === 0) return { ok: false, reason: "tasks가 비어 있음" };
  for (let i = 0; i < obj.tasks.length; i += 1) {
    const t = obj.tasks[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return { ok: false, reason: `tasks[${i}]가 오브젝트가 아님` };
    }
    const title = (t as Record<string, unknown>).title;
    if (typeof title !== "string" || !title.trim()) return { ok: false, reason: `tasks[${i}]에 title이 없음` };
  }
  if (obj.phases !== undefined && !Array.isArray(obj.phases)) return { ok: false, reason: "phases가 배열이 아님" };
  return { ok: true, plan: obj as RawPlan };
}

/** 후보 하나를 파싱·검증한다 */
function tryCandidate(source: string, reasons: string[]): RawPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (e) {
    reasons.push(e instanceof Error ? e.message : String(e));
    return null;
  }
  const checked = checkRawPlan(value);
  if (checked.ok) return checked.plan;
  reasons.push(checked.reason);
  return null;
}

/**
 * 응답 텍스트에서 플랜 JSON을 뽑는다.
 * 1차는 있는 그대로, 2차는 형식만 복구해서. 둘 다 실패하면 던진다 (깨진 플랜을 저장하지 않는다).
 */
function parsePlanJson(text: string): RawPlan {
  const reasons: string[] = [];
  const candidates = jsonCandidates(text);
  for (const candidate of candidates) {
    const plan = tryCandidate(candidate, reasons);
    if (plan) return plan;
  }
  for (const candidate of candidates) {
    const repaired = repairJson(candidate);
    // 잘린 응답을 닫아서 통과시키면 태스크가 조용히 사라진다 — 차라리 다시 받는다
    if (repaired.truncated) {
      reasons.push("응답이 중간에서 잘림");
      continue;
    }
    const plan = tryCandidate(repaired.text, reasons);
    if (plan) return plan;
  }
  throw new Error(`유효한 플랜 JSON을 찾지 못했습니다 (${reasons[0] ?? "응답에 JSON이 없음"})`);
}

/**
 * 플랜 JSON을 받아 온다. 파싱·검증에 실패하면 무엇이 잘못됐는지 알려 주고 형식만 다시 받는다.
 * 깨진 응답을 그대로 통과시키지 않는 것이 목적이라 재시도까지 실패하면 던진다.
 */
async function requestPlanJson(prompt: string, workdir: string | undefined, agent: PlanAgentOptions): Promise<RawPlan> {
  const text = await runAgent(prompt, workdir, agent);
  try {
    return parsePlanJson(text);
  } catch (first) {
    const firstReason = first instanceof Error ? first.message : String(first);
    const retryPrompt = `직전 응답을 JSON으로 읽을 수 없었다: ${firstReason}

아래는 그 응답 원문이다. 내용은 그대로 유지하고 형식만 고쳐서 유효한 JSON 하나만 다시 출력하라.
${JSON_FORMAT_RULES}

--- 직전 응답 ---
${text}`;
    // 형식 교정에는 탐색이 필요 없다 — 턴 상한을 낮춰 부른다
    const retried = await runAgent(retryPrompt, workdir, agent, 3);
    try {
      return parsePlanJson(retried);
    } catch (second) {
      const secondReason = second instanceof Error ? second.message : String(second);
      throw new Error(`플랜 JSON 파싱 실패: ${firstReason} / 형식 교정 재시도 후: ${secondReason}`);
    }
  }
}

/** 출력 형식 규칙 — 파싱을 깨뜨리는 흔한 습관을 미리 막는다 */
const JSON_FORMAT_RULES = `출력 형식 규칙:
- 코드펜스는 최상위 JSON을 감싸는 한 쌍만 쓴다. 문자열 값 안에는 백틱 세 개(코드펜스)를 넣지 않는다.
- 문자열 안의 줄바꿈은 \\n으로 이스케이프한다.
- 주석, 생략 표시(...), 트레일링 콤마를 쓰지 않는다. 태스크는 중간에 줄이지 말고 끝까지 출력한다.`;

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
  /** revise 응답에만 있는 필드 */
  revisionSummary?: string;
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

${JSON_FORMAT_RULES}
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
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : existing?.title ?? "Untitled plan",
    overview: typeof raw.overview === "string" ? raw.overview : "",
    phases,
    tasks,
  };
}

export interface GeneratePlanOptions extends PlanAgentOptions {
  /** config/projects.json 키 — 플랜에 기록해 착수 시 그 프로젝트 설정을 쓴다 */
  project?: string;
}

export async function generatePlan(goal: string, workdir: string, opts: GeneratePlanOptions = {}): Promise<Plan> {
  const prompt = `너는 시니어 엔지니어이자 플래너다. 아래 목표를 달성하기 위한 실행 계획을 세워라.
${workdir ? "현재 작업 디렉토리의 코드베이스를 필요한 만큼 탐색(Read/Glob/Grep)해서 현실적인 계획을 세워라." : ""}

## 목표
${goal}

${PLAN_SCHEMA_INSTRUCTIONS}`;

  const raw = await requestPlanJson(prompt, workdir, opts);
  const shaped = normalizePlanShape(raw);
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: shaped.title,
    goal,
    workdir,
    project: opts.project,
    planModel: opts.model,
    planEffort: opts.effort,
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

  const raw = await requestPlanJson(prompt, plan.workdir, { model: plan.planModel, effort: plan.planEffort });

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
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : plan.title,
    overview: typeof raw.overview === "string" ? raw.overview : plan.overview,
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
        summary:
          typeof raw.revisionSummary === "string" && raw.revisionSummary.trim()
            ? raw.revisionSummary
            : `코멘트 ${openComments.length}건 반영`,
        appliedCommentIds: appliedIds,
      },
    ],
  };
}
