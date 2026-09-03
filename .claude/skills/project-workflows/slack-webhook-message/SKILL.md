---
name: slack-webhook-message
description: >-
  Slack Incoming Webhook으로 보기 좋은 알림을 보내는 규칙. lib/notify.ts의 Notice → toSlack 변환,
  Block Kit 블록 구성, 글자 수 제한, 색 막대(attachments.color), mrkdwn 링크·날짜 표기,
  Discord와 같은 Notice를 공유하는 방법을 다룬다. 웹훅 알림을 추가·수정하거나
  "슬랙으로 보내줘", "알림 포맷 고쳐줘", "웹훅 메시지 예쁘게"라고 할 때 사용.
---

# Slack Webhook Message

이 프로젝트의 웹훅 알림은 **공급자 중립 `Notice` 하나 → Discord·Slack 페이로드 둘**로 갈라진다.
새 알림을 만들 때 Slack 전용 JSON을 손으로 짜지 않는다. `Notice`를 만들어 `sendNotice`에 넘긴다.

```ts
import { sendNotice } from "@/lib/notify";

void sendNotice({
  tone: "success",                       // info | success | failure | warning → 색·아이콘
  headline: "잡 완료: 로비 팝업 닫기 버튼", // 알림 미리보기 한 줄 (Slack text / Discord content)
  title: "로비 팝업 닫기 버튼 — TeenipingTycoon",
  url: prUrl,                            // 카드 대표 링크
  description: "무엇을 했는지 2~3문장",
  fields: [
    { name: "프로젝트", value: "TeenipingTycoon", inline: true },
    { name: "모드", value: "PR", inline: true },
  ],
  links: [{ label: "PR", url: prUrl }, { label: "보드", url: boardUrl }],
  footer: "job abc12345",
  timestamp: new Date().toISOString(),
});
```

호출은 항상 `void sendNotice(...)` — 응답 경로를 `await`로 막지 않는다 (CLAUDE.md 알림 규칙).

## Slack 페이로드가 만들어지는 방식 (`toSlack`)

```text
text        ← "{아이콘} {headline}"  — 푸시 알림·검색·스크린리더용 fallback. 반드시 채운다.
attachments[0]
  color     ← tone 색 (#2ecc71 등) — 왼쪽 색 막대. blocks를 attachment 안에 넣어야 색이 적용된다.
  blocks
    header  ← "{아이콘} {title}"  plain_text, 150자
    section ← description        mrkdwn, 3000자
    section ← fields (2열 그리드) 섹션당 10개, 각 2000자 — "*이름*\n값" 형식
    section ← 링크 줄            <url|라벨> 를 " · " 로 연결. 대표 url이 links에 있으면 그 라벨 사용
    context ← footer · 날짜       <!date^epoch^{date_short_pretty} {time}|fallback> 로 수신자 시간대 표시
```

## 지켜야 할 것

- **글자 제한**은 `clip()`이 처리한다. 새 블록을 추가하면 같은 제한을 건다: header 150, section text 3000, field 2000, context 요소 2000, 블록 최대 50개.
- **mrkdwn은 Markdown이 아니다.** 굵게 `*text*`, 기울임 `_text_`, 코드 `` `text` ``, 링크 `<url|label>`. `**`, `[label](url)`, `#` 헤딩은 그대로 글자로 찍힌다.
- 링크 라벨에 `<`, `>`, `|`가 들어가면 깨진다 — `slackLink()`가 걷어낸다. 라벨을 직접 조립하지 않는다.
- 이모지는 `emoji: true`인 header에서만 `:white_check_mark:` 식 단축코드가 동작한다. 유니코드 이모지는 어디서나 된다 — Notice 아이콘은 유니코드다.
- Incoming Webhook은 **파일 업로드를 못 한다.** 스크린샷·영상은 URL만 넣거나, Unity 쪽 `WebhookFeedback`(MyUtil)처럼 Bot 토큰 경로를 쓴다.
- 사용자 멘션이 필요하면 `<@U0123456>`(user id). 이름 텍스트 `@cykim`은 멘션이 안 된다.

## 환경변수

| 변수 | 의미 |
|---|---|
| `SLACK_WEBHOOK_URL` | 설정되면 Slack으로 전송 |
| `DISCORD_WEBHOOK_URL` | 설정되면 Discord로 전송 (둘 다 있으면 양쪽) |

값은 `.env.local`에만 둔다. 코드·로그·커밋에 URL을 넣지 않는다.

## 새 알림 종류를 추가할 때

1. `lib/notify.ts`에 `notifyXxx(...)` 함수를 추가 — 도메인 객체를 `Notice`로 바꾸는 일만 한다.
2. `tone`을 고른다: 사용자가 봐야 할 실패는 `failure`, 판단 대기는 `warning`, 정보성은 `info`.
3. `headline`은 채널 목록에서 잘려도 뜻이 통하게 40자 안팎으로.
4. 호출부에서 `void notifyXxx(...)`.
5. 로컬 확인: `.env.local`에 테스트 채널 웹훅을 넣고 흐름을 한 번 돌린다. 페이로드만 보려면
   `node --experimental-strip-types`로 `toSlack(notice)`를 찍어 [Block Kit Builder](https://app.slack.com/block-kit-builder)에 붙여 본다.
