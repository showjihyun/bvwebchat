// 서버 진입점 — createChatServer(RQ-01~18)를 실제 포트에 바인딩한다.
// dev: `npm run dev:server`(tsx watch) + Vite(:5173)가 /socket.io를 프록시.
// prod(RQ-05/ADR-0006): dist/client가 존재하면 그것을 정적 서빙하는 단일 서버 —
// 클라이언트와 Socket.IO가 한 포트(PORT, 기본 3001)로 노출된다.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatServer } from './createChatServer';
import { createStaticHandler } from './staticHandler';

const PORT = Number(process.env.PORT ?? 3001);

// 번들(dist/server/main.js) 기준 dist/client 위치. 소스 실행(dev)에서는 미존재 →
// 정적 핸들러 없이 Socket.IO만 뜨고 Vite가 클라이언트를 담당한다.
const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '../client');
const serveStatic = existsSync(clientDir);

const { httpServer } = createChatServer(serveStatic ? createStaticHandler(clientDir) : undefined);

httpServer.listen(PORT, () => {
  const mode = serveStatic ? `정적 클라이언트 + Socket.IO (${clientDir})` : 'Socket.IO 전용 (dev)';
  console.log(`[chat] 서버 실행 — http://localhost:${PORT} · ${mode}`);
});
