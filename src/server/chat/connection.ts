// 소켓 하나가 접속했을 때 벌어지는 일 전부 — **이벤트 이름 레지스트리**다.
// "이 서버가 받는 클라이언트 이벤트가 무엇인가"를 타입을 읽지 않고 답할 수
// 있는 유일한 파일이다.
//
// ⚠️ 이 함수 안의 **순서가 계약이다**:
//   1. socket.join(GLOBAL_ROOM)  — ADR-0004 결정1, 자동 참여
//   2. emitRoomsSnapshot          — RQ-13 계약 2-b, 접속 즉시 스냅샷
//   3. socket.on(...) 등록
// 클라이언트는 connect와 같은 틱에 identify를 보낼 수 있으므로 1·2가 3보다
// 먼저여야 한다. rq-12 GA-27(접속 직후 rooms 스냅샷을 곧바로 await)과
// rq-04(global 자동 참여)가 이 순서를 잡는다.
//
// 계층(ADR-0007 규칙2): L6 — 아래 계층 전부를 조립한다.

import { GLOBAL_ROOM } from '../../shared/types';
import type { ChatServer, ChatSocket } from './protocol';
import type { ChatState } from './state';
import { emitRoomsSnapshot } from './broadcast';
import { handleActiveRoom, handleIdentify, handleResume } from './session';
import { handleJoin, handleLeave, handleMessage } from './room';
import { scheduleDeparture } from './departure';

/** 소켓 1개분의 배선. createChatServer의 'connection' 리스너가 이것만 호출한다. */
export function registerSocketHandlers(io: ChatServer, state: ChatState, socket: ChatSocket): void {
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
  socket.on('resume', (payload, ack) => handleResume(io, state, socket, payload, ack));

  // RQ-10/RQ-15(기존) + RQ-18/ADR-0003 결정5(신설): 연결 종료 시 기존 즉시
  // 퇴장 처리(nickname 해제·participants/rooms 갱신·RQ-12 빈 room 삭제)를
  // 곧바로 실행하지 않고 30초 유예를 둔다 — 그 안에 동일 세션 토큰으로
  // resume이 오면 타이머가 취소되어 이 처리가 전혀 실행되지 않는다(GA-14).
  // 유예가 만료되면 finalizeDeparture가 기존 즉시 처리 전체를 실행하고,
  // 세션이 있었다면 그 안 읽음 개수까지 함께 버린다(ADR-0003 결정5).
  socket.on('disconnect', () => {
    scheduleDeparture(io, state, socket);
  });
}
