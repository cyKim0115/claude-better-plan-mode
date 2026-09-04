// 플랜 생성/수정/실행 완료, 원격 잡 완료 등을 Discord·Slack 웹훅으로 전송.
// - DISCORD_WEBHOOK_URL / SLACK_WEBHOOK_URL 중 설정된 곳으로만 보낸다 (둘 다 있으면 양쪽).
// - 둘 다 없으면 no-op. 실패해도 본 흐름을 막지 않음(로그만) — 반드시 fire-and-forget으로 호출할 것.
// - 메시지는 공급자 중립 구조(Notice)로 만들고, 공급자별 페이로드는 toDiscord / toSlack에서만 조립한다.
//   Slack 포맷 규칙은 .claude/skills/project-workflows/slack-webhook-message/SKILL.md 참고.

import { getTunnelUrl } from "./tunnel";
import type { Job, Plan, Run } from "./types";

// ---------------------------------------------------------------------------
// 공급자 중립 메시지
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "success" | "failure" | "warning";

export interface NoticeField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Notice {
  /** 알림 톤 — 색상·아이콘 결정 */
  tone: NoticeTone;
  /** 한 줄 헤드라인 (알림 미리보기에 뜨는 문장) */
  headline: string;
  /** 카드 제목 */
  title: string;
  /** 카드 제목에 걸 대표 링크 */
  url?: string;
  /** 본문 (길면 잘림) */
  description?: string;
  fields?: NoticeField[];
  /** 대표 링크 외 추가 링크 — "라벨: URL" 줄로 본문 뒤에 붙는다 */
  links?: Array<{ label: string; url: string }>;
  footer?: string;
  /** ISO 시각 */
  timestamp?: string;
}

const TONE_COLOR: Record<NoticeTone, { hex: string; int: number; icon: string }> = {
  info: { hex: "#5865f2", int: 0x5865f2, icon: "📋" },
  success: { hex: "#2ecc71", int: 0x2ecc71, icon: "✅" },
  failure: { hex: "#e74c3c", int: 0xe74c3c, icon: "❌" },
  warning: { hex: "#f1c40f", int: 0xf1c40f, icon: "⚠️" },
};

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export function toDiscord(n: Notice): Record<string, unknown> {
  const tone = TONE_COLOR[n.tone];
  const linkLines = (n.links ?? []).map((l) => `${l.label}: ${l.url}`).join("\n");
  return {
    content: clip(`${tone.icon} ${n.headline}${linkLines ? `\n${linkLines}` : ""}`, 2000),
    embeds: [
      {
        title: clip(n.title, 256),
        url: n.url,
        description: n.description ? clip(n.description, 1800) : undefined,
        color: tone.int,
        fields: (n.fields ?? []).slice(0, 25).map((f) => ({
          name: clip(f.name, 256),
          value: clip(f.value || "-", 1024),
          inline: f.inline ?? false,
        })),
        footer: n.footer ? { text: clip(n.footer, 2048) } : undefined,
        timestamp: n.timestamp,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Slack (Incoming Webhook + Block Kit)
// ---------------------------------------------------------------------------

/** Slack mrkdwn 링크 표기. 라벨에 들어가면 안 되는 문자를 걷어낸다. */
function slackLink(url: string, label: string): string {
  return `<${url}|${label.replace(/[<>|]/g, " ")}>`;
}

export function toSlack(n: Notice): Record<string, unknown> {
  const tone = TONE_COLOR[n.tone];
  const blocks: Array<Record<string, unknown>> = [];

  // header 블록은 plain_text만 허용, 150자 제한
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: clip(`${tone.icon} ${n.title}`, 150), emoji: true },
  });

  if (n.description) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(n.description, 2900) } });
  }

  // fields는 섹션당 최대 10개 — 2열 그리드로 배치된다
  const fields = (n.fields ?? []).filter((f) => f.value);
  for (let i = 0; i < fields.length; i += 10) {
    blocks.push({
      type: "section",
      fields: fields.slice(i, i + 10).map((f) => ({
        type: "mrkdwn",
        text: clip(`*${f.name}*\n${f.value}`, 2000),
      })),
    });
  }

  // 대표 링크가 links에도 있으면(예: PR) 그 라벨을 쓰고, 없으면 "열기"
  const links = n.links ?? [];
  const primary = links.find((l) => l.url === n.url);
  const linkParts: string[] = [];
  if (n.url) linkParts.push(slackLink(n.url, primary?.label ?? "열기"));
  for (const l of links) if (l.url !== n.url) linkParts.push(slackLink(l.url, l.label));
  if (linkParts.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: linkParts.join("  ·  ") } });
  }

  const contextParts: string[] = [];
  if (n.footer) contextParts.push(n.footer);
  if (n.timestamp) {
    const epoch = Math.floor(+new Date(n.timestamp) / 1000);
    contextParts.push(`<!date^${epoch}^{date_short_pretty} {time}|${n.timestamp}>`);
  }
  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: clip(contextParts.join("  ·  "), 2000) }],
    });
  }

  // attachments.color가 왼쪽 색 막대를 만든다 — blocks를 attachment 안에 넣어야 색이 적용된다
  return {
    text: clip(`${tone.icon} ${n.headline}`, 3000), // 알림 미리보기·접근성용 fallback
    attachments: [{ color: tone.hex, blocks }],
  };
}

// ---------------------------------------------------------------------------
// 전송
// ---------------------------------------------------------------------------

async function post(label: string, url: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`[notify] ${label} 웹훅 실패: ${res.status} ${await res.text()}`);
  } else {
    console.log(`[notify] ${label} 웹훅 전송 완료`);
  }
}

/** 설정된 모든 공급자에 전송. 예외는 삼키고 로그만 남긴다. */
export async function sendNotice(n: Notice): Promise<void> {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!discord && !slack) return;

  const jobs: Promise<void>[] = [];
  if (discord) jobs.push(post("Discord", discord, toDiscord(n)));
  if (slack) jobs.push(post("Slack", slack, toSlack(n)));
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[notify] 웹훅 전송 오류: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 플랜 보드 링크
// ---------------------------------------------------------------------------

type PlanLinks = {
  /** 임베드 url 등 링크를 하나만 쓸 수 있는 자리용 대표 링크 (터널이 있으면 공개 링크) */
  primary: string;
  /** 본문에 넣을 링크 목록 — 공개/로컬 모두 */
  links: Array<{ label: string; url: string }>;
  /** footer 문구 */
  footer: string;
};

/** 공개(ngrok)·로컬 링크를 함께 만들어 준다. 터널이 없으면 로컬 링크만. */
async function boardLinks(pathname: string, port: number): Promise<PlanLinks> {
  const publicBase = await getTunnelUrl(port);
  // WORKER_BOARD_URL(예: http://macmini-macmini:3000)이 있으면 다른 기기에서 열리는 주소로 링크한다
  const localBase = process.env.WORKER_BOARD_URL?.replace(/\/$/, "") || `http://localhost:${port}`;
  const localLink = `${localBase}${pathname}`;
  const publicLink = publicBase ? `${publicBase}${pathname}` : null;

  return {
    primary: publicLink ?? localLink,
    links: publicLink
      ? [
          { label: "공개", url: publicLink },
          { label: "로컬", url: localLink },
        ]
      : [{ label: "로컬", url: localLink }],
    footer: publicLink
      ? "공개 링크는 ngrok 터널 — 서버가 켜져 있는 동안만 유효"
      : "로컬 링크만 (ngrok 터널 없음)",
  };
}

// ---------------------------------------------------------------------------
// 플랜 알림
// ---------------------------------------------------------------------------

/** 플랜 생성 완료 알림. fire-and-forget으로 호출할 것 (void notifyPlanReady(...)). */
export async function notifyPlanReady(plan: Plan, port: number): Promise<void> {
  try {
    const links = await boardLinks(`/plan/${plan.id}`, port);
    await sendNotice({
      tone: "info",
      headline: `새 계획표가 준비됐어요: ${plan.title}`,
      title: plan.title,
      url: links.primary,
      description: plan.overview ? clip(plan.overview, 300) : plan.goal,
      fields: [
        { name: "태스크", value: String(plan.tasks.length), inline: true },
        { name: "리비전", value: String(plan.revision), inline: true },
        ...(plan.workdir ? [{ name: "작업 폴더", value: plan.workdir }] : []),
      ],
      links: links.links,
      footer: links.footer,
      timestamp: plan.updatedAt,
    });
  } catch (e) {
    console.warn(`[notify] 플랜 생성 알림 오류: ${e instanceof Error ? e.message : e}`);
  }
}

/** 계획표 수정(revise) 완료 알림 — 어떤 계획표가 수정됐는지 보고. fire-and-forget으로 호출할 것. */
export async function notifyPlanRevised(plan: Plan, appliedCount: number, port: number): Promise<void> {
  try {
    const links = await boardLinks(`/plan/${plan.id}`, port);
    const latest = plan.history[plan.history.length - 1];
    const summary = latest && latest.revision === plan.revision ? latest.summary : "변경 요약 없음";

    await sendNotice({
      tone: "warning",
      headline: `계획표 수정 완료: ${plan.title} (rev ${plan.revision})`,
      title: `${plan.title} — 리비전 ${plan.revision}`,
      url: links.primary,
      description: summary,
      fields: [
        { name: "반영된 코멘트", value: String(appliedCount), inline: true },
        { name: "태스크", value: String(plan.tasks.length), inline: true },
        { name: "리비전", value: String(plan.revision), inline: true },
      ],
      links: links.links,
      footer: links.footer,
      timestamp: plan.updatedAt,
    });
  } catch (e) {
    console.warn(`[notify] 수정 완료 알림 오류: ${e instanceof Error ? e.message : e}`);
  }
}

/** 착수(런) 완료 알림 — 수행 결과 요약 포함. fire-and-forget으로 호출할 것. */
export async function notifyRunComplete(plan: Plan, run: Run, port: number): Promise<void> {
  try {
    const links = await boardLinks(`/plan/${plan.id}`, port);
    const ok = run.status === "succeeded";

    const taskLines = run.taskIds
      .map((tid) => plan.tasks.find((t) => t.id === tid))
      .filter((t): t is Plan["tasks"][number] => Boolean(t))
      .map((t) => `${t.status === "done" ? "✅" : t.status === "failed" ? "❌" : "⏳"} ${t.title}`)
      .join("\n");

    const resultText = run.log
      .filter((l) => l.kind === "result")
      .map((l) => l.text)
      .join("\n\n")
      .trim();
    const summary = resultText || (ok ? "완료 (요약 없음)" : "실패 — 보드에서 로그를 확인하세요.");
    const remaining = plan.tasks.filter((t) => t.status === "pending").length;

    await sendNotice({
      tone: ok ? "success" : "failure",
      headline: `${ok ? "착수 완료" : "착수 실패"}: ${plan.title}`,
      title: `${run.taskIds.length}개 태스크 ${ok ? "수행 완료" : "수행 실패"} — ${plan.title}`,
      url: links.primary,
      description: summary,
      fields: [
        { name: "수행 태스크", value: taskLines || "-" },
        { name: "소요 시간", value: duration(run.startedAt, run.endedAt), inline: true },
        { name: "남은 태스크", value: String(remaining), inline: true },
        { name: "Run", value: run.id.slice(0, 8), inline: true },
      ],
      links: links.links,
      footer: links.footer,
      timestamp: run.endedAt ?? new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[notify] 런 완료 알림 오류: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------------------------------------------------------------------------
// 원격 잡 알림
// ---------------------------------------------------------------------------

/** 원격 워커 잡 종료 알림 (성공/실패/취소). fire-and-forget으로 호출할 것. */
export async function notifyJobFinished(job: Job, port: number): Promise<void> {
  try {
    const links = await boardLinks(`/jobs/${job.id}`, port);
    const ok = job.status === "succeeded";
    const cancelled = job.status === "cancelled";

    const resultText = job.log
      .filter((l) => l.kind === "result")
      .map((l) => l.text)
      .join("\n\n")
      .trim();
    const description =
      resultText ||
      job.error ||
      (ok ? "완료 (요약 없음)" : cancelled ? "사용자 요청으로 취소됨" : "실패 — 보드에서 로그를 확인하세요.");

    const verifyBad = job.verify === "failed" || job.verify === "timeout";
    const fields: NoticeField[] = [
      { name: "프로젝트", value: job.project, inline: true },
      { name: "모드", value: job.mode === "pr" ? "PR" : `${job.baseBranch} 직푸시`, inline: true },
      { name: "소요 시간", value: duration(job.startedAt ?? job.createdAt, job.endedAt), inline: true },
      { name: "브랜치", value: job.branch ?? "-", inline: true },
    ];
    if (job.commitCount !== undefined) fields.push({ name: "커밋", value: String(job.commitCount), inline: true });
    if (job.verify && job.verify !== "skipped") {
      fields.push({
        name: "Unity 검증",
        value: job.verify === "passed" ? "통과" : job.verify === "failed" ? "실패 — 머지 전 확인" : "시간 초과/정지 — 머지 전 확인",
        inline: true,
      });
    }
    if (job.model || job.effort) fields.push({ name: "모델", value: `${job.model ?? "기본"}${job.effort ? ` / ${job.effort}` : ""}`, inline: true });
    if (job.stage) fields.push({ name: "마지막 단계", value: job.stage, inline: true });
    if (!ok && job.worktree) fields.push({ name: "이어서 마무리", value: `job_resume 또는 보드의 "이어서 마무리" 버튼 (worktree: ${job.worktree})` });

    const extraLinks = [...links.links];
    if (job.prUrl) extraLinks.unshift({ label: "PR", url: job.prUrl });

    await sendNotice({
      tone: ok ? (verifyBad ? "warning" : "success") : cancelled ? "warning" : "failure",
      headline: `${ok ? (verifyBad ? "잡 완료 (검증 확인 필요)" : "잡 완료") : cancelled ? "잡 취소" : "잡 실패"}: ${job.title}`,
      title: `${job.title} — ${job.project}`,
      url: job.prUrl ?? links.primary,
      description,
      fields,
      links: extraLinks,
      footer: `job ${job.id.slice(0, 8)} · ${links.footer}`,
      timestamp: job.endedAt ?? new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[notify] 잡 완료 알림 오류: ${e instanceof Error ? e.message : e}`);
  }
}

function duration(startedAt: string, endedAt?: string): string {
  if (!endedAt) return "-";
  const s = Math.max(0, Math.round((+new Date(endedAt) - +new Date(startedAt)) / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
