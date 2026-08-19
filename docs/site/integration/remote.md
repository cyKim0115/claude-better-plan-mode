---
description: 같은 네트워크의 다른 기기나 외부에서 보드에 접근하는 방법과 보안 주의사항.
icon: globe
---

# Remote access

```powershell
npm run dev:lan    # 0.0.0.0 바인드 (프로덕션은 npm run start:lan)
```

| 접근 경로 | 방법 |
|-----------|------|
| 같은 네트워크 | `http://<이-PC의-IP>:3000` |
| 외부 | Tailscale 같은 사설망, 또는 `cloudflared tunnel` / `ngrok http 3000` |

{% hint style="danger" %}
**인증이 없는 앱입니다. 공인 인터넷에 그대로 노출하지 마세요.** 이 앱은 로컬에서 임의 코드 실행(`claude` CLI)을 트리거할 수 있습니다. 외부 접근은 반드시 사설망/터널로 감싸세요.
{% endhint %}

다음: [REST API](../reference/api.md)
