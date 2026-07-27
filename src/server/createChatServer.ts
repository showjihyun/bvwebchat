// 공개 조립점 — 이 서버의 계약은 여기서 끝난다.
//
// RQ-01 서버 계약 구현 (ADR-0001: Socket.IO). 계약 출처:
// tests/integration/rq-01-room-join.test.ts, _workspace/RQ-01/01_test-writer_red.md
//
// 구현은 전부 `./chat/` 아래 8개 모듈에 있다(ADR-0007). 이 파일이 `chat/`
// 안으로 들어가지 않는 이유는 하나다 — `src/server/main.ts`와 통합 테스트
// 11개 파일이 이 경로에서 createChatServer를 import 하며, 그 경로와 시그니처는
// 무변경이 하드 제약이다.
//
// 읽는 순서 안내:
//   chat/protocol.ts    전선 계약 (payload/ack/이벤트 맵) — 타입만
//   chat/state.ts       인스턴스별 장부 + ADR-0002/0003 상수 + 장부 연산 [PURE]
//   chat/validation.ts  이름·문자열 규칙                                 [PURE]
//   chat/broadcast.ts   방출 지점 (participants/rooms/unread — 청중 4종)
//   chat/session.ts     ADR-0003 전문 (identify/resume/activeRoom)
//   chat/room.ts        RQ-01/02/03/11/13/15 (join/message/leave)
//   chat/departure.ts   ADR-0003 결정5 유예 타이머 + ADR-0004 예외2
//   chat/connection.ts  소켓 1개당 배선 (이벤트 이름 레지스트리)

import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type { ChatServer } from './chat/protocol';
import { createChatState } from './chat/state';
import { registerSocketHandlers } from './chat/connection';

/**
 * RQ-01 서버 계약. 반환된 httpServer는 listen()되지 않은 상태다 — 포트 결정은
 * 호출자 책임 (테스트는 0을 지정해 임의 포트를 배정받는다).
 *
 * `requestListener`(RQ-05/ADR-0006): Socket.IO 경로(/socket.io/) 외의 HTTP 요청을
 * 처리할 핸들러. 프로덕션에서 정적 클라이언트 서빙을 주입하는 용도다. 생략하면
 * 기존 동작(비-소켓 요청 무응답 — 테스트는 socket.io-client만 사용)과 동일하다.
 */
export function createChatServer(requestListener?: RequestListener): {
  httpServer: HttpServer;
  io: ChatServer;
} {
  const httpServer = createServer(requestListener);
  const io: ChatServer = new SocketIOServer(httpServer);

  // ADR-0007 규칙1: 이 서버 인스턴스가 소유하는 장부 전체를 여기서 한 번
  // 만든다. 모듈 스코프가 아니라 호출마다 새로 만들어지므로 테스트가 같은
  // 워커에서 서버를 여러 개 띄워도 장부가 서로 섞이지 않는다 — "1 서버 =
  // 1 장부"가 이 한 줄로 보인다.
  const state = createChatState();

  io.on('connection', (socket) => registerSocketHandlers(io, state, socket));

  return { httpServer, io };
}
