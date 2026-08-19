// 플랜 생성/실행 완료 시 보드 링크를 Discord 웹훅으로 전송.
// ngrok 공개 링크와 로컬 링크를 함께 보고한다(터널이 없으면 로컬만).
// DISCORD_WEBHOOK_URL 미설정 시 no-op. 실패해도 본 흐름을 막지 않음(로그만).

import { getTunnelUrl } from "./tunnel";
import type { Plan, Run } from "./types";

type PlanLinks = {
  /** 임베드 url 등 링크를 하나만 쓸 수 있는 자리용 대표 링크 (터널이 있으면 공개 링크) */
  primary: string;
  /** 메시지 본문에 넣을 링크 블록 — 공개/로컬 모두 */
  body: string;
  /** 임베드 footer 문구 */
  footer: string;
};

/** 공개(ngrok)·로컬 링크를 함께 만들어 준다. 터널이 없으면 로컬 링크만. */
async function planLinks(planId: string, port: number): Promise<PlanLinks> {
  const publicBase = await getTunnelUrl(port);
  const localLink = `http://localhost:${port}/plan/${planId}`;
  const publicLink = publicBase ? `${publicBase}/plan/${planId}` : null;

  return {
    primary: publicLink ?? localLink,
    body: publicLink ? `공개: ${publicLink}\n로컬: ${localLink}` : `로컬: ${localLink}`,
    footer: publicLink
      ? "공개 링크는 ngrok 터널 — 서버가 켜져 있는 동안만 유효"
      : "로컬 링크만 (ngrok 터널 없음)",
  };
}

/** 플랜 생성 완료 알림. fire-and-forget으로 호출할 것 (void notifyPlanReady(...)). */
export async function notifyPlanReady(plan: Plan, port: number): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  try {
    const links = await planLinks(plan.id, port);

    const payload = {
      content: `📋 새 계획표가 준비됐어요: **${plan.title}**\n${links.body}`,
      embeds: [
        {
          title: plan.title,
          url: links.primary,
          description: plan.overview
            ? plan.overview.length > 300
              ? `${plan.overview.slice(0, 300)}…`
              : plan.overview
            : plan.goal,
          color: 0x5865f2,
          fields: [
            { name: "태스크", value: String(plan.tasks.length), inline: true },
            { name: "리비전", value: String(plan.revision), inline: true },
            ...(plan.workdir ? [{ name: "작업 폴더", value: plan.workdir, inline: false }] : []),
          ],
          footer: { text: links.footer },
          timestamp: plan.updatedAt,
        },
      ],
    };

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[notify] Discord 웹훅 실패: ${res.status} ${await res.text()}`);
    } else {
      console.log(`[notify] Discord 웹훅 전송 완료: ${links.primary}`);
    }
  } catch (e) {
    console.warn(`[notify] 웹훅 전송 오류: ${e instanceof Error ? e.message : e}`);
  }
}

/** 계획표 수정(revise) 완료 알림 — 어떤 계획표가 수정됐는지 보고. fire-and-forget으로 호출할 것. */
export async function notifyPlanRevised(plan: Plan, appliedCount: number, port: number): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  try {
    const links = await planLinks(plan.id, port);

    // 이번 리비전의 변경 요약 (history 마지막 항목)
    const latest = plan.history[plan.history.length - 1];
    const summary =
      latest && latest.revision === plan.revision ? latest.summary : "변경 요약 없음";

    const payload = {
      content: `✏️ 계획표 수정 완료: **${plan.title}** (rev ${plan.revision})\n${links.body}`,
      embeds: [
        {
          title: `${plan.title} — 리비전 ${plan.revision}`,
          url: links.primary,
          description: summary.length > 1800 ? `${summary.slice(0, 1800)}…` : summary,
          color: 0xf1c40f,
          fields: [
            { name: "반영된 코멘트", value: String(appliedCount), inline: true },
            { name: "태스크", value: String(plan.tasks.length), inline: true },
            { name: "리비전", value: String(plan.revision), inline: true },
          ],
          footer: { text: links.footer },
          timestamp: plan.updatedAt,
        },
      ],
    };

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[notify] 수정 완료 웹훅 실패: ${res.status} ${await res.text()}`);
    } else {
      console.log(`[notify] 수정 완료 웹훅 전송: ${links.primary} (rev ${plan.revision})`);
    }
  } catch (e) {
    console.warn(`[notify] 수정 완료 웹훅 오류: ${e instanceof Error ? e.message : e}`);
  }
}

/** 착수(런) 완료 알림 — 수행 결과 요약 포함. fire-and-forget으로 호출할 것. */
export async function notifyRunComplete(plan: Plan, run: Run, port: number): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  try {
    const links = await planLinks(plan.id, port);
    const ok = run.status === "succeeded";

    // 수행 태스크별 최종 상태
    const taskLines = run.taskIds
      .map((tid) => plan.tasks.find((t) => t.id === tid))
      .filter((t): t is Plan["tasks"][number] => Boolean(t))
      .map((t) => `${t.status === "done" ? "✅" : t.status === "failed" ? "❌" : "⏳"} ${t.title}`)
      .join("\n");

    // Claude가 남긴 최종 결과 요약 (stream-json result 이벤트)
    const resultText = run.log
      .filter((l) => l.kind === "result")
      .map((l) => l.text)
      .join("\n\n")
      .trim();
    const summary = resultText || (ok ? "완료 (요약 없음)" : "실패 — 보드에서 로그를 확인하세요.");

    const remaining = plan.tasks.filter((t) => t.status === "pending").length;

    const payload = {
      content: `${ok ? "✅ 착수 완료" : "❌ 착수 실패"}: **${plan.title}**\n${links.body}`,
      embeds: [
        {
          title: `${run.taskIds.length}개 태스크 ${ok ? "수행 완료" : "수행 실패"} — ${plan.title}`,
          url: links.primary,
          description: summary.length > 1800 ? `${summary.slice(0, 1800)}…` : summary,
          color: ok ? 0x2ecc71 : 0xe74c3c,
          fields: [
            { name: "수행 태스크", value: taskLines.slice(0, 1024) || "-", inline: false },
            { name: "소요 시간", value: runDuration(run), inline: true },
            { name: "남은 태스크", value: String(remaining), inline: true },
            { name: "Run", value: run.id.slice(0, 8), inline: true },
          ],
          footer: { text: links.footer },
          timestamp: run.endedAt ?? new Date().toISOString(),
        },
      ],
    };

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[notify] 런 완료 웹훅 실패: ${res.status} ${await res.text()}`);
    } else {
      console.log(`[notify] 런 완료 웹훅 전송: ${links.primary} (${run.status})`);
    }
  } catch (e) {
    console.warn(`[notify] 런 완료 웹훅 오류: ${e instanceof Error ? e.message : e}`);
  }
}

function runDuration(run: Run): string {
  if (!run.endedAt) return "-";
  const s = Math.max(0, Math.round((+new Date(run.endedAt) - +new Date(run.startedAt)) / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
