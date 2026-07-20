// 서버 진입점 — createChatServer(RQ-01)를 실제 포트에 바인딩한다.
// dev: `npm run dev:server` (tsx watch). 클라이언트(Vite :5173)는 /socket.io를
// 이 서버(:3001)로 프록시해 접속한다 (vite.config.ts).
import { createChatServer } from './createChatServer';

const PORT = Number(process.env.PORT ?? 3001);
const { httpServer } = createChatServer();

httpServer.listen(PORT, () => {
  console.log(`[chat] Socket.IO 서버 실행 — http://localhost:${PORT}`);
});
