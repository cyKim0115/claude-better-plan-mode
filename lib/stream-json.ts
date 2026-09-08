// claude -p --output-format stream-json 한 줄 → 사람이 읽는 로그 항목.
// runner.ts와 jobs.ts가 모두 이 변환기를 쓴다. 플랜 착수의 진행 마커는
// assistant/result 텍스트를 lib/plan-run.ts에 넘겨 처리하고, 로그에는 마커를 걷어낸 텍스트만 남긴다.

import type { RunLogLine } from "./types";

export interface StreamEvent {
  kind: RunLogLine["kind"];
  text: string;
  /** result 이벤트의 성공 여부 (result가 아니면 undefined) */
  resultOk?: boolean;
  /** 이벤트에 실려 온 claude 세션 id — 잡의 "이어서하기"(claude --resume)가 이 값을 쓴다 */
  sessionId?: string;
}

/** 파싱된 stream-json 객체를 로그 항목 목록으로 변환. 모르는 이벤트는 빈 배열. */
export function streamEventToLog(obj: Record<string, unknown>): StreamEvent[] {
  const type = obj.type as string;
  const sessionId = typeof obj.session_id === "string" && obj.session_id ? obj.session_id : undefined;

  if (type === "system") {
    if ((obj.subtype as string) === "init") {
      const model = (obj as { model?: string }).model ?? "?";
      const where = sessionId ? `, session: ${sessionId.slice(0, 8)}` : "";
      return [{ kind: "system", text: `세션 시작 (model: ${model}${where})`, sessionId }];
    }
    return [];
  }

  if (type === "assistant") {
    const out: StreamEvent[] = [];
    const message = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "assistant", text: block.text.trim() });
      } else if (block.type === "tool_use") {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const hint =
          (input?.file_path as string) ??
          (input?.path as string) ??
          (input?.command as string) ??
          (input?.pattern as string) ??
          "";
        out.push({ kind: "tool", text: `${name} ${typeof hint === "string" ? hint.slice(0, 200) : ""}`.trim() });
      }
    }
    return out;
  }

  if (type === "result") {
    const subtype = obj.subtype as string;
    const resultText = (obj as { result?: string }).result;
    const ok = subtype === "success";
    return [{ kind: "result", text: ok ? resultText?.trim() || "완료" : `실패: ${subtype}`, resultOk: ok, sessionId }];
  }

  return [];
}

/**
 * stdout 청크를 줄 단위로 잘라 stream-json을 파싱하는 누적기.
 * JSON이 아닌 줄은 info로 그대로 넘긴다 (파싱 실패로 스트림이 죽지 않게).
 */
export function createLineParser(onEvent: (ev: StreamEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          onEvent({ kind: "info", text: line.slice(0, 500) });
          continue;
        }
        if (parsed && typeof parsed === "object") {
          for (const ev of streamEventToLog(parsed as Record<string, unknown>)) onEvent(ev);
        }
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (rest) onEvent({ kind: "info", text: rest.slice(0, 500) });
    },
  };
}
