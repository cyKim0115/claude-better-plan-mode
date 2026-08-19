// ngrok 터널 싱글턴 — 플랜 보드를 외부에서 접근 가능한 공개 URL로 노출.
// NGROK_AUTHTOKEN 필요. 패키지(@ngrok/ngrok) 미설치·토큰 미설정 시 null 반환(알림은 로컬 URL로 폴백).

type TunnelState = {
  url: string | null;
  port: number;
  promise: Promise<string | null> | null;
};

// next dev 핫리로드에도 터널이 중복 생성되지 않도록 globalThis에 보관
const g = globalThis as unknown as { __planmodeTunnel?: TunnelState };

function state(): TunnelState {
  if (!g.__planmodeTunnel) {
    g.__planmodeTunnel = { url: null, port: 0, promise: null };
  }
  return g.__planmodeTunnel;
}

/** 앱이 리슨 중인 포트로 ngrok 터널을 열고 공개 URL을 반환. 이미 열려 있으면 재사용. */
export async function getTunnelUrl(port: number): Promise<string | null> {
  const s = state();
  if (s.url && s.port === port) return s.url;
  if (s.promise && s.port === port) return s.promise;
  if (!process.env.NGROK_AUTHTOKEN) return null;

  s.port = port;
  s.promise = (async () => {
    try {
      // 동적 import: 패키지가 없어도 앱 부팅에는 영향 없음
      const ngrok = (await import("@ngrok/ngrok" as string)) as {
        forward: (opts: Record<string, unknown>) => Promise<{ url(): string | null }>;
      };
      const listener = await ngrok.forward({
        addr: port,
        authtoken_from_env: true,
      });
      s.url = listener.url();
      console.log(`[tunnel] ngrok 터널 열림: ${s.url} -> localhost:${port}`);
      return s.url;
    } catch (e) {
      console.warn(`[tunnel] ngrok 터널 실패: ${e instanceof Error ? e.message : e}`);
      s.promise = null;
      return null;
    }
  })();
  return s.promise;
}
