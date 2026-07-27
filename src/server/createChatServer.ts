// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md
//
// RQ-18(안 읽음 개수) / ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션
// 토큰) 계약 추가. 계약 출처: tests/integration/rq-18-unread.test.ts,
// _workspace/RQ-18/01_test-writer_red.md, docs/adr/0003-user-identity.md.

import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { GLOBAL_ROOM, type ChatMessage, type RoomName } from '../shared/types';
import type {
  ChatServer,
  ChatSocket,
  JoinAck,
  JoinPayload,
  LeaveAck,
  LeavePayload,
  MessagePayload,
} from './chat/protocol';
import {
  addMember,
  appendMessage,
  createChatState,
  deleteRoomState,
  GRACE_PERIOD_MS,
  removeMember,
  type ChatState,
} from './chat/state';
import { isNonEmptyString, isReservedRoomNameForCreation } from './chat/validation';
import { broadcastParticipants, broadcastRooms, emitRoomsSnapshot } from './chat/broadcast';
import {
  attachRoomToSession,
  detachRoomFromSession,
  discardSession,
  fanOutUnread,
  handleActiveRoom,
  handleIdentify,
  handleResume,
  markSessionDisconnected,
} from './chat/session';

/** RQ-01 본체: 이 소켓을 room의 수신자 목록에 추가한다 (Socket.IO room = 수신자 목록). */
function handleJoin(
  io: ChatServer,
  state: ChatState,
  socket: ChatSocket,
  payload: JoinPayload,
  ack: (result: JoinAck) => void
): void {
  if (!isNonEmptyString(payload?.room) || !isNonEmptyString(payload?.nickname)) {
    ack({ ok: false, error: 'room과 nickname은 비어 있지 않은 문자열이어야 한다' });
    return;
  }

  // ADR-0004 결정 3 / RQ-13 GA-24: 'global'은 대소문자 무관 예약 이름 — 사용자의
  // room 생성 요청에서 거부한다. socket.join·roomMembers 갱신·'rooms' 방송
  // 모두 발생시키지 않는다("사용자 생성 room 집합"이 전혀 바뀌지 않으므로).
  if (isReservedRoomNameForCreation(payload.room)) {
    ack({ ok: false, error: `'${GLOBAL_ROOM}'은 예약된 이름이라 room 생성에 사용할 수 없다` });
    return;
  }

  socket.join(payload.room);
  socket.data.nickname = payload.nickname;
  // RQ-11: socket.join 직후 await 없이 동기적으로 히스토리 스냅샷을 읽어
  // ack에 포함한다. Node.js 이벤트 루프는 단일 스레드이므로 이 사이에 다른
  // 소켓의 'message' 핸들러가 끼어들 수 없다 — 히스토리 스냅샷과 이후 라이브
  // 브로드캐스트 사이에 누락·중복 창이 구조적으로 생기지 않는다 (test-writer
  // 계약, _workspace/RQ-11/01_test-writer_red.md §2 원자성 전제).
  const history = state.histories.get(payload.room) ?? [];
  ack({ ok: true, history: [...history] });

  // RQ-18 / ADR-0003: 이 소켓에 바인딩된 세션이 있으면(identify를 호출한
  // 소켓만) 이 room을 세션의 참여 room 집합에 추가한다 — 이후 이 room에
  // 도착하는 메시지가 안 읽음 집계 대상이 된다(활성 room이 아닐 때).
  // 세션 없는 소켓(identify 미호출)은 이 로직을 건너뛰어 기존 RQ-01~15
  // 동작을 그대로 유지한다(세션리스 소켓 회귀 방지).
  attachRoomToSession(state, socket, payload.room);

  // RQ-15: 이 room의 멤버 순서 기록에 이 소켓을 추가한다(참여 순 — 맨 뒤에
  // append). RQ-13: 이 join 직전에 멤버가 0명(키 부재 포함)이었는지를 먼저
  // 확인해 둔다 — "사용자 생성 room 집합"에 새로 추가되는 순간(0→1 전이)인지
  // 판단하는 데 쓴다(신설 계약 3번).
  const { isNewUserRoom, memberCount } = addMember(state, payload.room, socket.id);

  // room이 비어 있다가 이 join으로 최초 멤버(1명)가 된 경우는 방송을
  // 생략한다 — 알려야 할 "기존 멤버"가 아직 존재하지 않기 때문이다(설계
  // 결정). 이 생략은 관찰 가능한 계약(GA-19/20)에 영향을 주지 않을 뿐 아니라
  // 실제로 필요하다: 이 방송을 항상 보내면, 이후 두 번째 참여자가 들어올 때
  // 첫 번째 참여자가 등록하는 리스너(참여 순간 직전 등록)가 그 사이 뒤늦게
  // 도착하는 "1인 방송" 패킷을 대신 소비해 버려 다음 방송을 놓치는 경합이
  // 실측으로 재현된다(join ack와 참여자 방송이 별도 네트워크 왕복이라 도착
  // 순서가 보장되지 않음). 멤버가 2명 이상일 때만 방송하면 이 경합이
  // 구조적으로 사라진다.
  if (memberCount > 1) {
    broadcastParticipants(io, state, payload.room);
  }

  // RQ-13: 이 join으로 "사용자 생성 room 집합"이 바뀌었다면(0→1 전이) 존재
  // room 목록을 전 접속자에게 방송한다(GA-21). participants와 달리 room
  // 미참여자도 대상이므로 broadcastParticipants와 별개로 io.emit 경로를 쓴다.
  if (isNewUserRoom) {
    broadcastRooms(io, state);
  }
}

/** join으로 등록된 nickname을 조회해 room 멤버 전원에게 브로드캐스트한다. */
function handleMessage(io: ChatServer, state: ChatState, socket: ChatSocket, payload: MessagePayload): void {
  const nickname = socket.data.nickname;
  if (!isNonEmptyString(nickname) || !isNonEmptyString(payload?.room)) {
    return;
  }

  // room 격리는 서버가 강제한다 (RQ-02): 발신 소켓이 payload.room의 실제
  // 멤버가 아니면 브로드캐스트를 생략한다.
  if (!socket.rooms.has(payload.room)) {
    return;
  }

  const message: ChatMessage = {
    room: payload.room,
    nickname,
    body: payload.body,
  };
  io.to(payload.room).emit('message', message);

  // RQ-11 / ADR-0002: 브로드캐스트에 부가해 room당 최근 50개 링버퍼에
  // 저장한다 (기존 브로드캐스트 로직은 변경하지 않는다). appendMessage가
  // 돌려주는 post-append 길이를 그대로 아래 상한 계산에 넘겨, 별도 map
  // 재조회 없이 항상 최신 길이를 참조하게 한다.
  //
  // RQ-18 / ADR-0003 결정4: 이 room에 참여 중인(global 포함) 세션 중 이
  // room이 활성 room이 아닌 세션의 안 읽음을 1 증가시켜 유니캐스트로
  // 통지한다. 상한(범위 제약 ②, GA-17)은 이 room이 현재 보관한 메시지 수
  // (방금 갱신한 링버퍼 길이, ADR-0002 상한 50)로 클램프한다 — 열었을 때
  // 이미 밀려나 볼 수 없는 메시지는 세지 않는다는 요구와 일치한다.
  const cap = appendMessage(state, payload.room, message);
  fanOutUnread(io, state, payload.room, cap);
}

/** RQ-03 본체: 이 소켓을 room의 수신자 목록에서 제거한다 (Socket.IO room = 수신자 목록). */
function handleLeave(
  io: ChatServer,
  state: ChatState,
  socket: ChatSocket,
  payload: LeavePayload,
  ack: (result: LeaveAck) => void
): void {
  if (!isNonEmptyString(payload?.room)) {
    ack({ ok: false, error: 'room은 비어 있지 않은 문자열이어야 한다' });
    return;
  }

  // ADR-0004 결정 1: global은 예약된 상설 room이며 탈퇴할 수 없다. 멤버십은
  // 유지한 채 ack만 거부해 클라이언트가 "나갔다"고 오인하지 않게 한다.
  //
  // ⚠️ 이 검사는 **정확 일치**다 — join의 isReservedRoomNameForCreation
  // (대소문자 무시)과 의도적으로 다르다. 여기에 그 함수를 끌어다 쓰면
  // leave({room:'GLOBAL'})의 결과가 ok:true → ok:false로 바뀌는데, 이를
  // 덮는 테스트가 없어 무증상 행동 변경이 된다(ADR-0007 결과 절).
  if (payload.room === GLOBAL_ROOM) {
    ack({ ok: false, error: 'global room은 탈퇴할 수 없다' });
    return;
  }

  socket.leave(payload.room);
  ack({ ok: true });

  // RQ-18 / ADR-0003 결정4: 이 소켓에 세션이 있으면 참여 room 집합·안 읽음
  // 기록에서 이 room을 제거한다. 이 room이 활성 room이었다면 활성 room은
  // 다시 없음(null)으로 되돌아간다(파생 테스트로 검증).
  detachRoomFromSession(state, socket, payload.room);

  // RQ-15: 이 room의 멤버 순서 기록에서 이 소켓을 제거하고 갱신된 참여자
  // 목록을 남은 room 멤버 전원에게 방송한다. RQ-13: 이 제거로 멤버가 0명이
  // 됐다면("사용자 생성 room 집합"에서 제거되는 1→0 전이) 존재 room 목록도
  // 전 접속자에게 방송한다(GA-23, 신설 계약 3번).
  const { becameEmpty: becameEmptyUserRoom } = removeMember(state, payload.room, socket.id);
  broadcastParticipants(io, state, payload.room);
  if (becameEmptyUserRoom) {
    broadcastRooms(io, state);
  }

  // RQ-12 / ADR-0004 예외 2: 이 leave로 room이 완전히 비면(마지막 멤버 이탈)
  // roomMembers·roomHistories에서 이 room의 엔트리를 완전히 삭제한다(빈
  // 배열/빈 이력을 남기던 기존 동작 대체 — RQ-11 히스토리 잔존, RQ-15
  // minor-3 빈 배열 잔존 해소). GLOBAL_ROOM은 이 함수 상단에서 이미 별도
  // 분기로 거부돼 여기 도달하지 않으므로(ADR-0004 결정 1) 별도 예외 처리
  // 없이도 이 삭제 대상에서 자동으로 제외된다. 위 방송 호출(순서·조건)은
  // 그대로 두고 그 뒤에만 상태를 정리한다 — 방송 시점엔 이미 멤버 배열이
  // 비어 있어(length === 0) 삭제 전후로 방송 결과가 달라지지 않는다.
  if (becameEmptyUserRoom) {
    deleteRoomState(state, payload.room);
  }
}

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
