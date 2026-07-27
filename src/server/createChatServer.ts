// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md
//
// RQ-18(안 읽음 개수) / ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션
// 토큰) 계약 추가. 계약 출처: tests/integration/rq-18-unread.test.ts,
// _workspace/RQ-18/01_test-writer_red.md, docs/adr/0003-user-identity.md.

import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { GLOBAL_ROOM, type RoomName } from '../shared/types';
import type { ChatServer, ChatSocket } from './chat/protocol';
import { createChatState, deleteRoomState, GRACE_PERIOD_MS, removeMember, type ChatState } from './chat/state';
import { broadcastParticipants, broadcastRooms, emitRoomsSnapshot } from './chat/broadcast';
import { discardSession, handleActiveRoom, handleIdentify, handleResume, markSessionDisconnected } from './chat/session';
import { handleJoin, handleLeave, handleMessage } from './chat/room';

/**
 * RQ-15: 연결이 끊긴 소켓을 이 소켓이 join(RQ-01)으로 등록돼 있던 모든 room의
 * 멤버 순서 기록에서 제거하고, 각 room마다 갱신된 참여자 목록을 남은 멤버에게
 * 방송한다. Socket.IO의 'disconnect' 이벤트 시점엔 소켓이 이미 모든
 * Socket.IO room에서 빠진 뒤라 socket.rooms로는 소속 room을 알 수 없지만,
 * roomMembers는 서버가 직접 관리하는 별도 장부이므로 이 시점에도 소켓이
 * 어느 room들의 멤버였는지 안전하게 조회할 수 있다(test-writer 계약의
 * "disconnecting 이벤트로 스냅샷" 힌트 대신 택한 대안 — 자체 장부가 이미
 * 있으므로 추가 이벤트 리스너 없이 동일한 결과를 얻는다).
 */
function handleDisconnect(io: ChatServer, state: ChatState, socket: ChatSocket): void {
  let userRoomSetChanged = false;
  // RQ-12: 이 disconnect로 완전히 빈 room이 된 것들을 모아 뒀다가 루프 종료
  // 후 한 번에 삭제한다(순회 중인 Map을 직접 변형하지 않기 위함 — 한 소켓이
  // 여러 room의 마지막 멤버였을 수 있다).
  const emptiedRooms: RoomName[] = [];
  for (const [room] of state.members) {
    const { removed, becameEmpty } = removeMember(state, room, socket.id);
    if (!removed) continue;
    broadcastParticipants(io, state, room);
    // RQ-13: 이 room이 이 disconnect로 0명이 됐다면 "사용자 생성 room 집합"이
    // 바뀐 것이다(1→0 전이) — 존재 room 목록 방송이 필요하다는 표시만 남기고
    // 계속 순회한다(한 소켓이 여러 room의 마지막 멤버였을 수 있으므로 방송은
    // 루프 종료 후 한 번만 보낸다).
    if (becameEmpty) {
      userRoomSetChanged = true;
      emptiedRooms.push(room);
    }
  }
  if (userRoomSetChanged) {
    broadcastRooms(io, state);
  }

  // RQ-12 / ADR-0004 예외 2: 위 방송이 모두 끝난 뒤 완전히 빈 room의 서버
  // 상태(roomMembers·roomHistories)를 삭제한다. GLOBAL_ROOM은 roomMembers
  // 순회 대상에 애초에 등록되지 않으므로(RQ-15 설계 결정) 이 루프 자체에
  // 나타나지 않아 삭제 대상에서 구조적으로 제외된다.
  for (const room of emptiedRooms) {
    deleteRoomState(state, room);
  }
}



/**
 * RQ-18 / ADR-0003 결정5: 모든 socket disconnect에 적용되는 30초 퇴장
 * 유예를 스케줄한다 — 기존 즉시 퇴장 처리(nickname 해제·handleDisconnect)를
 * 곧바로 실행하지 않고 이 타이머 만료 시점(finalizeDeparture)으로 미룬다.
 * 세션이 있는 소켓(identify 완료)이면 세션을 "연결 끊김" 상태로 표시하고
 * 타이머를 세션에 보관해 resume이 취소할 수 있게 한다. 세션이 없는 소켓
 * (identify 미호출)도 유예 자체는 동일하게 적용되지만, 취소할 세션이 없으므로
 * 타이머는 무조건 만료된다(세션리스 소켓도 유예 대상이라는 계약, 파일 상단
 * 테스트 주석 "세션리스 소켓 회귀 방지" 참고).
 * timer.unref()로 이 타이머가 프로세스 종료를 막지 않게 한다 — 유예를 취소
 * 하지 않는 시나리오(예: GA-27)에서 테스트/프로세스가 실제 30초를 불필요하게
 * 기다리지 않도록 하기 위함이며, 타이머가 실행되는 시점·동작에는 영향이 없다.
 */
function scheduleDeparture(io: ChatServer, state: ChatState, socket: ChatSocket): void {
  // 토큰은 **스케줄 시점**에 스냅샷해 콜백 인자로 넘긴다. 반면
  // finalizeDeparture가 읽는 identifiedNickname은 **발화 시점**에 읽는다 —
  // 이 비대칭은 의도적이다(다른 소켓에서의 resume이 옛 소켓의 타이머로
  // 엉뚱한 닉네임을 해제하지 않게 한다).
  const token = socket.data.token;

  const timer = setTimeout(() => {
    finalizeDeparture(io, state, socket, token);
  }, GRACE_PERIOD_MS);
  timer.unref();

  markSessionDisconnected(state, token, timer);
}

/**
 * 퇴장 유예(30초)가 resume 없이 만료됐을 때 실행되는 확정 처리 —
 * 기존(RQ-01~15) 즉시 퇴장 처리(nickname 해제·handleDisconnect)를 그대로
 * 수행하고, 세션이 있었다면 그 세션(안 읽음 개수 포함)을 완전히 버린다
 * (ADR-0003 결정5 마지막 문장 — RQ-18 범위는 "참여 중인 room"이므로 퇴장이
 * 확정되면 더 이상 참여 중이 아니다).
 */
function finalizeDeparture(io: ChatServer, state: ChatState, socket: ChatSocket, token: string | undefined): void {
  const heldNickname = socket.data.identifiedNickname;
  if (heldNickname !== undefined) {
    state.nicknamesInUse.delete(heldNickname);
  }
  handleDisconnect(io, state, socket);
  discardSession(state, token);
}

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
