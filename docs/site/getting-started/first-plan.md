---
description: 목표와 대상 프로젝트 경로를 입력해 첫 플랜을 만들고 보드로 이동합니다.
icon: rocket
---

# First plan

{% stepper %}
{% step %}
### 홈에서 목표 입력

`http://localhost:3000` 첫 화면의 텍스트박스에 목표를 적습니다.

> 예: "로그인 기능에 OAuth를 추가하고 테스트까지 작성"

<figure><img src="../images/home.jpg" alt="홈 화면 — 목표 입력과 플랜 목록"><figcaption>홈 화면: 목표 입력 + 플랜 목록</figcaption></figure>
{% endstep %}
{% step %}
### 대상 프로젝트 경로 입력

Claude가 탐색·실행할 리포의 **절대경로**를 입력합니다 (예: `C:\Users\me\repo\my-project`). 비워도 플랜은 생성되지만 부분 착수(실행)에는 필요합니다.
{% endstep %}
{% step %}
### 플랜 생성

**플랜 생성**을 누르면 즉시 보드로 이동하고, 백그라운드에서 Claude가 계획을 만듭니다. 코드베이스 크기에 따라 수 분 걸릴 수 있으며, 완료되면 보드에 자동으로 나타납니다(3초 폴링).

<figure><img src="../images/generating.jpg" alt="생성 중 보드"><figcaption>생성 중 — 완료되면 자동 갱신</figcaption></figure>
{% endstep %}
{% step %}
### 결과 확인

overview, phase별 태스크 카드, 수정 이력이 보이면 성공입니다. 이제 [보드 사용법](../guide/board.md)으로.
{% endstep %}
{% endstepper %}

{% hint style="info" %}
생성이 실패하면 보드 상단에 오류가 표시됩니다. 대부분 `claude` CLI 미로그인 또는 경로 오타입니다.
{% endhint %}

다음: [Board tour](../guide/board.md) · [Comments & revise](../guide/comments.md)
