import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Plan, PlanComment } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "plans");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function planPath(id: string) {
  // id는 우리가 생성한 uuid만 허용
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("invalid plan id");
  return path.join(DATA_DIR, `${id}.json`);
}

export async function listPlans(): Promise<Plan[]> {
  await ensureDir();
  const files = await fs.readdir(DATA_DIR);
  const plans: Plan[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, f), "utf8");
      plans.push(JSON.parse(raw) as Plan);
    } catch {
      // skip corrupt file
    }
  }
  plans.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return plans;
}

export async function getPlan(id: string): Promise<Plan | null> {
  await ensureDir();
  try {
    const raw = await fs.readFile(planPath(id), "utf8");
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

export async function savePlan(plan: Plan): Promise<Plan> {
  await ensureDir();
  plan.updatedAt = new Date().toISOString();
  const p = planPath(plan.id);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(plan, null, 2), "utf8");
  await fs.rename(tmp, p);
  return plan;
}

export async function deletePlan(id: string): Promise<void> {
  await ensureDir();
  await fs.rm(planPath(id), { force: true });
}

export function newId(): string {
  return randomUUID();
}

export function makeComment(taskId: string | null, text: string, author = "me"): PlanComment {
  return {
    id: newId(),
    taskId,
    author,
    text,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
}
