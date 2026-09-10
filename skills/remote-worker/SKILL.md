---
name: remote-worker
description: >-
  서브 PC(mac-worker MCP)에 코드 작업을 위임하고 결과를 받는 방법. 사용자가 "mac-worker로", "서브 PC에서",
  "맥에서 돌려", "원격으로 시켜", "워커에 맡겨", "TeenipingTycoon 작업 시켜", 잡 상태·로그·취소·재개·화면 확인,
  PR/직푸시·모델·추론 레벨 선택을 요청할 때 사용. worker_projects / job_submit / job_status / job_logs /
  job_list / job_cancel / job_resume / worker_screenshot / worker_cleanup 툴이 보이면 이 스킬을 따른다.
---

# Remote Worker

`mac-worker` MCP는 다른 PC(서브 PC)에서 돌아가는 워커다. 여기서 툴을 호출하면 **저쪽 PC가** worktree를 만들고
`claude -p`를 돌려 커밋 → (Unity 검증) → push/PR까지 끝낸 뒤 Slack으로 알린다. 이 세션은 지시를 넘기고
상태를 읽는 역할만 한다. 이 PC의 파일을 고치는 작업이 아니다.

## 흐름

1. **프로젝트 확인** — 처음이거나 프로젝트 이름이 불확실하면 `worker_projects`. 사용자가 말한 이름이
   목록에 없으면 가장 가까운 키를 제안하고 확인받는다. 추측으로 제출하지 않는다.
2. **모드 결정** — 사용자가 말하지 않으면 `pr`. `direct`(기본 브랜치 직푸시)는 사용자가 **명시**했을 때만.
   프로젝트가 direct를 잠가 두었으면(`worker_projects`에 "잠김") 오류가 돌아온다 — 그대로 전달하고 pr로 재제출할지 묻는다.
3. **모델·추론 레벨** — 사용자가 "opus로", "빠르게/sonnet으로", "깊게 생각해서/effort max" 같이 말하면
   `model`·`effort`에 넣는다. 말하지 않으면 **둘 다 생략**한다 (프로젝트 기본값 → 워커 PC 기본값 순으로 적용된다).
   `effort`는 `low | medium | high | xhigh | max`. 모델은 alias(`sonnet`, `opus`, `haiku`, `fable`) 또는 전체 이름.
4. **지시문 작성** — `job_submit`의 `prompt`는 저쪽 세션이 받는 전부다. 아래 "지시문" 절을 따른다.
   Unity 검증이 그 프로젝트에서 계속 정지·실패하는 상황이면 `skipVerify: true`로 제출한다 — 사용자가 검증을
   원할 때는 붙이지 않는다. 이미 제출한 잡도 **아직 시작 전(`queued`)이면** 보드 `/jobs/<id>/edit`에서
   지시문·모드·모델·검증 생략을 고칠 수 있다고 안내한다.
5. **제출 후 보고** — `job_submit`은 즉시 `jobId`와 보드 URL을 돌려준다. 사용자에게 다음 세 가지를 전한다:
   jobId(앞 8자리), 보드 URL, "끝나면 Slack으로 알림이 간다". 그리고 **기다리지 않는다.**
6. **상태 확인** — 사용자가 물을 때만 `job_status`. 자동으로 반복 폴링하지 않는다 (잡은 수 분~수십 분 걸린다).
   `running`이면 "마지막 활동 N분 전"도 같이 전한다. 자세한 로그가 필요하면 `job_logs`를 `since` 커서로 증분 조회.
7. **완료 처리** — `succeeded`면 PR 링크(또는 direct면 "기본 브랜치 반영됨, git pull 필요")를 전한다.
   `Unity 검증: failed/timeout`이 붙어 있으면 PR은 올라갔지만 **머지 전 확인이 필요**하다고 반드시 말한다.
   `failed`면 `error`와 마지막 단계(`stage`)를 전하고, 로그에서 원인 한 줄을 뽑아 준다.

## 멈추거나 실패했을 때 — 반드시 마무리한다

원격 잡은 "조용히 멈춘 상태"로 두지 않는다. 워커 자체가 워치독으로 멈춘 프로세스를 죽이고 잡을 확정하지만,
그 뒤 처리는 이 세션의 몫이다.

- `failed` / `cancelled` 인데 worktree가 남아 있으면 → **`job_resume(jobId)`** 로 커밋 단계부터 이어서 push·PR까지 끝낸다.
  claude 세션은 다시 돌지 않는다. 이미 만들어진 변경을 원격에 올리는 용도다.
- 실패 원인이 Unity 검증(시간 초과·컴파일 실패)이고 사용자가 "그냥 올려"라고 하면 → `job_resume(jobId, skipVerify: true)`.
  같은 프로젝트의 뒤이은 잡도 같은 곳에서 걸린다 — 이어서 제출할 때는 `skipVerify: true`를 붙이거나,
  대기 중인 잡은 보드에서 검증 생략으로 고치도록 안내한다.
- `pr` 모드는 검증 전에 브랜치를 먼저 push하므로, 검증이 죽어도 작업물은 원격에 있다. 그래도 PR이 없으면 `job_resume`.
- `direct` 모드는 검증을 통과해야만 push한다. 실패 시 선택지는 둘: `job_resume(skipVerify)` 또는 pr 모드로 재제출.
- 변경 자체가 잘못됐으면 resume하지 말고 새 잡으로 재제출한다.
- `running`인데 마지막 활동이 30분 넘게 없으면 워치독이 곧 처리한다. 사용자가 급하면 `job_cancel` → `job_resume`.

## 지시문(prompt) 쓰는 법

저쪽 세션은 이 대화를 모른다. 대화에서 나온 맥락을 prompt에 **다시 써 넣는다.**

- 무엇을 / 어디에 / 어떤 기준으로 끝났다고 볼지 — 세 가지를 문장으로.
- 관련 파일·클래스·씬 이름을 알고 있으면 적는다. 저쪽이 탐색하는 시간이 준다.
- 프로젝트 규칙은 저쪽 CLAUDE.md가 처리한다. 커밋 형식·코딩 컨벤션을 여기서 반복하지 않는다.
- **push·PR 지시는 넣지 않는다.** 워커가 자동으로 붙이며, 세션이 push하면 흐름이 깨진다.
- `title`은 커밋·PR·Slack 제목이 된다. 40자 안쪽 명사구로 (예: `로비 팝업 닫기 버튼 추가`).

예:

```text
title:  로비 팝업 닫기 버튼 추가
prompt: LobbyPopup 프리팹 우상단에 닫기 버튼을 추가하고 OnClickClose로 팝업을 닫아라.
        버튼은 인스펙터 On Click()에 연결하는 방식(코드 AddListener 금지)을 따른다.
        컴파일 오류 없음을 확인하고, 변경한 파일 목록을 요약에 남겨라.
```

## 화면 확인

사용자가 "지금 화면 어때", "Unity 상태 봐줘"라고 하면 `worker_screenshot`. 이미지가 돌아오면 보이는 대로
설명한다 (에디터가 열려 있는지, 에러 창이 떠 있는지, 어떤 씬인지). 잡이 `claude` 단계에서 오래 멈춰 있을 때
원인을 볼 용도로도 쓴다.

## 취소·재제출

- "취소해" → `job_cancel(jobId)`. 실행 중이던 프로세스가 죽고 worktree는 남는다.
- "다시 시켜"(내용을 바꿔서) → 취소 후 새 `job_submit`. "마저 끝내"(내용은 그대로) → `job_resume`.
- 같은 프로젝트 잡은 순서대로 실행된다. 여러 개를 연달아 제출해도 되지만, 서로 의존하는 작업이면
  앞 잡이 끝난 뒤 제출하라고 권한다 (앞 잡의 PR이 머지되기 전엔 뒤 잡이 그 변경을 못 본다).

## 잔여물 정리

worktree·브랜치는 워커가 보관 기한(기본 48시간, 저장 안 된 변경이 남았으면 168시간)에 맞춰 알아서 치운다.
평소에 `worker_cleanup`을 부르지 않는다. 부르는 경우는 둘뿐이다.

- 사용자가 "디스크 꽉 찼어", "워크트리 정리해", "뭐가 남아 있어?"라고 물을 때 → `worker_cleanup({ dryRun: true })`로
  현황(경로·용량·남긴 이유)을 먼저 보여 주고, 지울지 물은 뒤 `worker_cleanup({ force: true })`.
- `job_resume`이 "worktree가 이미 정리됐습니다"로 실패할 때 → 이어서 마무리는 불가능하다. 새 `job_submit`으로 다시 시킨다.

커밋·push 안 된 변경이 남은 worktree는 `force`로도 남는다. 그것까지 지우려면 `includeUnsaved: true`가 필요한데,
**사용자가 잃어도 된다고 확인했을 때만** 쓴다.

## 연결이 안 될 때

툴 목록에 `worker_unreachable`만 보이거나 호출이 "연결하지 못했습니다"로 끝나면 이 PC 문제가 아니다.
사용자에게 순서대로 확인을 요청한다: 서브 PC 전원·Tailscale 연결, 브라우저에서 보드 URL(`http://<host>:3000/jobs`)이
열리는지, 토큰이 서브 PC `.env.local`의 `WORKER_TOKEN`과 같은지. 그 이상은 이 세션에서 할 수 있는 게 없다.

## 하지 않는 것

- 잡을 대신 기다리며 폴링 루프를 돌지 않는다.
- 이 PC에서 같은 작업을 직접 하지 않는다 — 사용자가 워커를 지목한 데는 이유가 있다 (Unity 인스턴스·환경).
- `skipPermissions: true`는 사용자가 명시적으로 요구할 때만.
- 토큰·URL 값을 대화에 출력하지 않는다.
