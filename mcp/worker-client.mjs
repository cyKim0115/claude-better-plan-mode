#!/usr/bin/env node
/**
 * 원격 워커 stdio 브리지 — 메인 PC(Windows 등)에서 실행.
 *
 * Claude Desktop처럼 HTTP MCP에 헤더를 붙일 수 없는 호스트를 위해, stdio MCP 서버로 떠서
 * 모든 툴 호출을 서브 PC의 mcp/worker.mjs(Streamable HTTP + Bearer)로 그대로 넘긴다.
 * Claude Code는 HTTP 트랜스포트를 직접 지원하므로 이 브리지 없이도 되지만, 같은 설정을
 * 두 호스트에 맞추고 싶으면 양쪽 다 이걸 써도 된다.
 *
 * 환경변수:
 *   WORKER_URL     예: http://macmini-macmini:4000/mcp   (필수)
 *   WORKER_TOKEN   서브 PC .env.local의 WORKER_TOKEN      (필수)
 *
 * Claude Desktop (claude_desktop_config.json):
 *   "mac-worker": { "command": "node", "args": ["C:\\Users\\me\\repo\\claude-better-plan-mode\\mcp\\worker-client.mjs"],
 *                   "env": { "WORKER_URL": "http://macmini-macmini:4000/mcp", "WORKER_TOKEN": "..." } }
 *
 * Claude Code:
 *   claude mcp add mac-worker -s user -e WORKER_URL=http://macmini-macmini:4000/mcp -e WORKER_TOKEN=... -- node <위 경로>
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const URL_RAW = process.env.WORKER_URL ?? "";
const TOKEN = process.env.WORKER_TOKEN ?? "";

function log(msg) {
  // stdout은 MCP 프로토콜 전용 — 로그는 stderr로만
  process.stderr.write(`[worker-client] ${msg}\n`);
}

if (!URL_RAW || !TOKEN) {
  log("WORKER_URL 과 WORKER_TOKEN 환경변수가 필요합니다.");
  process.exit(1);
}
const upstreamUrl = new URL(URL_RAW);

// ---------------------------------------------------------------------------
// 업스트림(서브 PC) 연결 — 첫 요청 때 붙고, 끊기면 다음 요청에서 다시 붙는다.
// 호스트가 켜질 때 서브 PC가 꺼져 있어도 브리지 자체는 죽지 않게 한다.
// ---------------------------------------------------------------------------
let upstream = null;

async function getUpstream() {
  if (upstream) return upstream;
  const transport = new StreamableHTTPClientTransport(upstreamUrl, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "better-plan-worker-bridge", version: "0.1.0" });
  transport.onclose = () => {
    if (upstream === client) upstream = null;
  };
  transport.onerror = (e) => log(`업스트림 오류: ${e instanceof Error ? e.message : e}`);
  await client.connect(transport);
  upstream = client;
  log(`업스트림 연결: ${upstreamUrl.origin}`);
  return client;
}

async function withUpstream(fn) {
  try {
    return await fn(await getUpstream());
  } catch (e) {
    // 연결이 죽어 있었으면 한 번 재연결해서 재시도
    upstream = null;
    try {
      return await fn(await getUpstream());
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(`서브 PC 워커(${upstreamUrl.origin})에 연결하지 못했습니다: ${msg} — 워커가 켜져 있는지, Tailscale이 연결돼 있는지, 토큰이 맞는지 확인하세요.`);
    }
  }
}

// ---------------------------------------------------------------------------
// stdio 서버 — 툴 목록·호출을 그대로 전달
// ---------------------------------------------------------------------------
const server = new Server({ name: "mac-worker", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await withUpstream((c) => c.listTools());
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    // 목록 조회 실패 시 빈 목록 대신 상태 확인용 툴 하나를 노출해 원인을 사용자에게 보여준다
    return {
      tools: [
        {
          name: "worker_unreachable",
          description: `서브 PC 워커에 연결하지 못했습니다 (${upstreamUrl.origin}). 이 툴을 호출하면 재시도합니다.`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "worker_unreachable") {
    try {
      const tools = await withUpstream((c) => c.listTools());
      return { content: [{ type: "text", text: `연결 복구됨. 사용 가능한 툴: ${tools.tools.map((t) => t.name).join(", ")} — 세션을 다시 시작하면 툴 목록이 갱신됩니다.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  }
  try {
    return await withUpstream((c) => c.callTool({ name, arguments: args ?? {} }));
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
});

process.stdin.on("close", () => process.exit(0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

await server.connect(new StdioServerTransport());
log(`브리지 준비 완료 → ${upstreamUrl.origin}`);
