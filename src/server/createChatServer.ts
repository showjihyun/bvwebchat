// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md
//
// RQ-18(안 읽음 개수) / ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션
// 토큰) 계약 추가. 계약 출처: tests/integration/rq-18-unread.test.ts,
// _workspace/RQ-18/01_test-writer_red.md, docs/adr/0003-user-identity.md.

import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { GLOBAL_ROOM } from '../shared/types';
import type { ChatServer } from './chat/protocol';
import { createChatState } from './chat/state';
import { emitRoomsSnapshot } from './chat/broadcast';
import { handleActiveRoom, handleIdentify, handleResume } from './chat/session';
import { handleJoin, handleLeave, handleMessage } from './chat/room';
import { scheduleDeparture } from './chat/departure';

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
  // 워커에서 서버를 여러 개 띄워도 장부가 서로 섞이지 않는다.
  const state = createChatState();

  io.on('connection', (socket) => {
    // ADR-0004 결정 1: 모든 접속 사용자는 global에 자동 참여하며 탈퇴할 수
    // 없다. nickname은 설정하지 않는다 — 수신은 room 멤버십만으로 충분하고,
    // nickname은 발신(handleMessage)에만 필요하다.
    socket.join(GLOBAL_ROOM);

    // RQ-13 신설 계약 2-b: 신규 접속자에게 그 순간의 존재 room 목록 스냅샷을
    // 유니캐스트로 즉시 전달한다. GLOBAL_ROOM이 항상 포함돼 목록이 결코
    // 비지 않으므로 조건 없이 항상 보낸다.
    emitRoomsSnapshot(socket, state);

    socket.on('identify', (payload, ack) => handleIdentify(state, socket, payload, ack));
    socket.on('join', (payload, ack) => handleJoin(io, state, socket, payload, ack));
    socket.on('message', (payload) => handleMessage(io, state, socket, payload));
    socket.on('leave', (payload, ack) => handleLeave(io, state, socket, payload, ack));
    // RQ-18: 활성 room 통지(ADR-0003 결정4)·세션 복원(결정1-2·5) — 세션이
    // 없는 소켓(identify 미호출)에서 호출되면 각 핸들러가 ok:false로 거부한다.
    socket.on('activeRoom', (payload, ack) => handleActiveRoom(state, socket, payload, ack));
    socket.on('resume', (payload, ack) => handleResume(state, socket, payload, ack));

    // RQ-10/RQ-15(기존) + RQ-18/ADR-0003 결정5(신설): 연결 종료 시 기존 즉시
    // 퇴장 처리(nickname 해제·participants/rooms 갱신·RQ-12 빈 room 삭제)를
    // 곧바로 실행하지 않고 30초 유예를 둔다 — 그 안에 동일 세션 토큰으로
    // resume이 오면 타이머가 취소되어 이 처리가 전혀 실행되지 않는다(GA-14).
    // 유예가 만료되면 finalizeDeparture가 기존 즉시 처리 전체를 실행하고,
    // 세션이 있었다면 그 안 읽음 개수까지 함께 버린다(ADR-0003 결정5).
    socket.on('disconnect', () => {
      scheduleDeparture(io, state, socket);
    });
  });

  return { httpServer, io };
}
