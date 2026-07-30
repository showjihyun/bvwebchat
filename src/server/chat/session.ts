// ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션 토큰) 전문이 사는 곳.
// 토큰 발급·닉네임 점유·활성 room·안 읽음 집계, 그리고 세션 장부를 만지는
// 모든 연산.
//
// ADR-0003의 5개 결정과 이 파일의 대응:
//   결정1-2 토큰 발급/재개 → handleIdentify(randomUUID) · handleResume
//   결정3   토큰이 진실 공급원 → sessionOfSocket이 token으로만 세션을 찾는다
//   결정4   세션당 활성 room 1개 → handleActiveRoom · fanOutUnread
//   결정5   퇴장 유예 30초 → markSessionDisconnected · discardSession
//           (타이머 자체를 **만드는** 것은 departure.ts의 몫이다 — ADR-0007 규칙4)
//
// **세션리스 소켓 회귀 방지**가 이 파일의 최우선 불변식이다. RQ-01~15 골든
// 케이스의 대다수는 identify를 한 번도 호출하지 않는 소켓을 굴린다. 그런
// 소켓에 대해 세션 로직은 전부 조용히 no-op이어야 하며, 그 가드는
// sessionOfSocket 한 곳에만 있다.
//
// 계층(ADR-0007 규칙2): L4 — protocol·state·validation·broadcast에 의존한다.
// **room.ts를 import 하지 않는다** — handleResume은 handleJoin을 재사용하지
// 않는다(예약 이름 검사·히스토리 ack·rooms 방송을 전부 건너뛰는 별개 경로다).

import { randomUUID } from 'node:crypto';
import { GLOBAL_ROOM, type RoomName } from '../../shared/types';
import type {
  ActiveRoomAck,
  ActiveRoomPayload,
  ChatServer,
  ChatSocket,
  IdentifyAck,
  IdentifyPayload,
  ResumeAck,
  ResumePayload,
} from './protocol';
import { replaceMember, type ChatState, type SessionState } from './state';
import { generateUniqueNickname, isNonBlankString, isNonEmptyString } from './validation';
import { emitUnreadToSocket, emitUnreadToSocketId } from './broadcast';

/**
 * 이 소켓에 바인딩된 세션을 조회한다 — **세션리스 소켓 회귀 방지의 단일 지점**.
 *
 * identify를 호출한 적 없는 소켓은 socket.data.token이 undefined이고, 그런
 * 소켓에 대해 세션 로직은 전부 조용히 건너뛰어야 한다(RQ-01~15 골든 케이스의
 * 대다수가 identify 없이 join한다). 토큰이 있어도 세션이 이미 버려졌을 수
 * 있으므로(유예 만료·재identify) 두 단계 모두 확인한다.
 *
 * 주의: handleActiveRoom은 이 헬퍼를 쓰지 않는다 — "토큰 없음"과 "세션 없음"에
 * **서로 다른 에러 문자열**로 ack해야 하므로 두 분기를 유지해야 한다.
 */
function sessionOfSocket(state: ChatState, socket: ChatSocket): SessionState | undefined {
  const token = socket.data.token;
  if (token === undefined) {
    return undefined;
  }
  return state.sessions.get(token);
}

/**
 * RQ-18 / ADR-0003: 이 room을 세션의 참여 room 집합에 추가한다 — 이후 이
 * room에 도착하는 메시지가 안 읽음 집계 대상이 된다(활성 room이 아닐 때).
 * 세션 없는 소켓은 아무것도 하지 않는다.
 */
export function attachRoomToSession(state: ChatState, socket: ChatSocket, room: RoomName): void {
  const session = sessionOfSocket(state, socket);
  if (session === undefined) {
    return;
  }
  session.rooms.add(room);
}

/**
 * RQ-18 / ADR-0003 결정4: 세션의 참여 room 집합·안 읽음 기록에서 이 room을
 * 제거한다. 이 room이 활성 room이었다면 활성 room은 다시 없음(null)으로
 * 되돌아간다(파생 테스트로 검증). 세션 없는 소켓은 아무것도 하지 않는다.
 */
export function detachRoomFromSession(state: ChatState, socket: ChatSocket, room: RoomName): void {
  const session = sessionOfSocket(state, socket);
  if (session === undefined) {
    return;
  }
  session.rooms.delete(room);
  session.unread.delete(room);
  if (session.activeRoom === room) {
    session.activeRoom = null;
  }
}

/**
 * RQ-18 / ADR-0003 결정4: 이 room에 참여 중인(global 포함) 세션 중 이 room이
 * 활성 room이 아닌 세션의 안 읽음을 1 증가시켜 유니캐스트로 통지한다.
 *
 * `cap`은 appendMessage가 돌려준 **post-append 링버퍼 길이**여야 한다
 * (GA-17) — 열었을 때 이미 밀려나 볼 수 없는 메시지는 세지 않는다.
 * 순회 순서는 sessions Map의 삽입 순서이며, 이는 unread 방출 순서를 결정한다
 * (현재 관찰 불가능하지만 room→sessions 인덱스를 도입하면 달라진다).
 */
export function fanOutUnread(io: ChatServer, state: ChatState, room: RoomName, cap: number): void {
  for (const session of state.sessions.values()) {
    if (!session.rooms.has(room)) continue;
    if (session.activeRoom === room) continue;
    const current = session.unread.get(room) ?? 0;
    const next = Math.min(current + 1, cap);
    session.unread.set(room, next);
    if (session.connected) {
      emitUnreadToSocketId(io, session.socketId, { room, count: next });
    }
  }
}

/**
 * ADR-0003 결정5: 세션을 "연결 끊김"으로 표시하고 유예 타이머 핸들을 세션에
 * 보관한다 — resume이 이 핸들로 타이머를 취소한다. 세션 없는 소켓
 * (identify 미호출)은 취소할 주체가 없으므로 아무것도 하지 않는다(타이머
 * 자체는 그대로 진행되어 무조건 만료된다).
 */
export function markSessionDisconnected(
  state: ChatState,
  token: string | undefined,
  timer: NodeJS.Timeout
): SessionState | undefined {
  const session = token !== undefined ? state.sessions.get(token) : undefined;
  if (session === undefined) {
    return undefined;
  }
  session.connected = false;
  session.graceTimer = timer;
  return session;
}

/**
 * ADR-0003 결정5 마지막 문장: 퇴장이 확정되면 세션을 안 읽음 개수까지 통째로
 * 버린다 — 더 이상 어떤 room에도 "참여 중"이 아니다. 세션 없는 소켓의
 * 퇴장에서는 버릴 것이 없다.
 */
export function discardSession(state: ChatState, token: string | undefined): void {
  if (token === undefined) {
    return;
  }
  state.sessions.delete(token);
}

/**
 * RQ-10 본체: nickname 입력만으로 사용자를 식별한다(계정·비밀번호 없음).
 * 이미 사용 중인 nickname이면 자동 접미사로 고유화한다(GA-11).
 *
 * identify와 join은 의도적으로 느슨하게 연결한다(test-writer 계약 참고) —
 * join은 여전히 자신의 payload.nickname을 그대로 신뢰하며 이 함수가 건드리지
 * 않는다. socket.data.nickname은 identify 시점에도 채워 두지만(발신 편의),
 * join이 호출되면 join의 값으로 덮어써진다 — 두 계약이 충돌하지 않는다.
 */
export function handleIdentify(
  state: ChatState,
  socket: ChatSocket,
  payload: IdentifyPayload,
  ack: (result: IdentifyAck) => void
): void {
  if (!isNonBlankString(payload?.nickname)) {
    ack({ ok: false, error: 'nickname은 비어 있지 않은 문자열이어야 한다' });
    return;
  }

  // 이 소켓이 이전에 이미 identify로 nickname을 점유했다면 먼저 해제한다 —
  // 재식별 시 "자기 자신이 점유 중인 nickname"을 "타인이 사용 중"으로 오판해
  // 불필요한 접미사가 붙는 자기 충돌을 막는다.
  const previouslyHeld = socket.data.identifiedNickname;
  if (previouslyHeld !== undefined) {
    state.nicknamesInUse.delete(previouslyHeld);
  }

  // RQ-18: 이 소켓이 이전에 이미 세션(토큰)을 발급받았다면(동일 소켓에서
  // identify 재호출) 그 세션은 더 이상 어떤 소켓에서도 재개될 수 없으므로
  // 버린다 — "새 신원 발급"은 항상 새 세션을 만든다는 의도적 분리
  // (ADR-0003 결정1-2, resume과의 유일한 차이).
  const previousToken = socket.data.token;
  if (previousToken !== undefined) {
    state.sessions.delete(previousToken);
  }

  const assigned = generateUniqueNickname(payload.nickname, state.nicknamesInUse);
  state.nicknamesInUse.add(assigned);
  socket.data.identifiedNickname = assigned;
  socket.data.nickname = assigned;

  // RQ-18 / ADR-0003 결정1-2: 서버 발급 불투명 세션 토큰을 부여하고 세션
  // 상태를 초기화한다. global은 모든 소켓이 접속 즉시 자동 참여하므로
  // (ADR-0004 결정1) 세션의 참여 room 집합에도 처음부터 포함시킨다 —
  // GA-16이 요구하는 "global도 안 읽음 집계 대상"의 전제.
  const token = randomUUID();
  socket.data.token = token;
  state.sessions.set(token, {
    nickname: assigned,
    rooms: new Set([GLOBAL_ROOM]),
    activeRoom: null,
    unread: new Map(),
    socketId: socket.id,
    connected: true,
    graceTimer: undefined,
  });

  ack({ ok: true, nickname: assigned, token });
}

/**
 * RQ-18 본체 — activeRoom(payload:{room}, ack) (ADR-0003 결정4). 세션이 없는
 * 소켓(identify 미호출)에는 활성 room 개념 자체가 성립하지 않으므로 거부한다.
 * 참여하지 않은 room을 통지하면 거부하고 활성 room은 불변이다(GA-18, GA-10과
 * 동일 원칙 — 격리는 서버가 강제한다).
 *
 * 이 핸들러가 io를 받지 않는 것은 타입 수준의 신호다 — 활성 room 통지는
 * 방송을 유발하지 않고 자기 소켓에만 응답한다.
 */
export function handleActiveRoom(
  state: ChatState,
  socket: ChatSocket,
  payload: ActiveRoomPayload,
  ack: (result: ActiveRoomAck) => void
): void {
  // 여기서 sessionOfSocket을 쓰지 않는 이유: 두 실패가 서로 다른 에러
  // 문자열로 ack돼야 한다(RQ-18 계약).
  const token = socket.data.token;
  if (token === undefined) {
    ack({ ok: false, error: '세션이 없다 — 먼저 identify로 세션을 발급받아야 한다' });
    return;
  }
  const session = state.sessions.get(token);
  if (session === undefined) {
    ack({ ok: false, error: '세션을 찾을 수 없다' });
    return;
  }
  if (!isNonEmptyString(payload?.room) || !session.rooms.has(payload.room)) {
    ack({ ok: false, error: '참여하지 않은 room은 활성 room으로 설정할 수 없다' });
    return;
  }

  // ADR-0003 결정4: 참여 room이면 활성 room을 갱신하고 그 room의 안 읽음을
  // 0으로 초기화한 뒤 unread 이벤트로 통지한다(GA-13).
  session.activeRoom = payload.room;
  session.unread.set(payload.room, 0);
  ack({ ok: true });
  emitUnreadToSocket(socket, { room: payload.room, count: 0 });
}

/**
 * RQ-18 본체 — resume(payload:{token}, ack) (ADR-0003 결정1-2·5). 살아있는
 * 세션(연결 중 또는 유예 30초 이내)이면 이 소켓에 세션을 재바인딩하고,
 * 참여 중이던 모든 room(global 포함)에 이 소켓을 실제로 재합류(socket.join)
 * 시켜 이후 메시지 라우팅·참여자 목록(RQ-15)이 끊김 없이 이어지게 한다.
 * 대기 중인 퇴장 확정 타이머(scheduleDeparture)를 취소한다.
 *
 * **handleJoin을 재사용하지 않는다** — 여기서는 예약 이름 검사도, 히스토리
 * ack도, 'rooms' 방송도 일어나지 않는다. 재사용하면 계층 순환(session→room)이
 * 생기는 동시에 행동이 바뀐다.
 *
 * 타이머 취소는 clearTimeout 인라인이다 — departure.ts를 import 하면
 * L4→L5 역방향 간선이 생긴다(ADR-0007 규칙2).
 */
export function handleResume(
  state: ChatState,
  socket: ChatSocket,
  payload: ResumePayload,
  ack: (result: ResumeAck) => void
): void {
  const token = payload?.token;
  if (!isNonEmptyString(token)) {
    ack({ ok: false, error: 'token은 비어 있지 않은 문자열이어야 한다' });
    return;
  }
  const session = state.sessions.get(token);
  if (session === undefined) {
    ack({ ok: false, error: '세션을 찾을 수 없다(만료되었거나 존재하지 않는다)' });
    return;
  }

  // 대기 중이던 퇴장 확정 타이머를 취소한다 — 유예 내 재접속이므로 즉시
  // 퇴장 처리는 전혀 실행되지 않는다.
  if (session.graceTimer !== undefined) {
    clearTimeout(session.graceTimer);
    session.graceTimer = undefined;
  }

  const previousSocketId = session.socketId;
  session.socketId = socket.id;
  session.connected = true;
  socket.data.token = token;
  socket.data.nickname = session.nickname;
  socket.data.identifiedNickname = session.nickname;

  // 참여 중이던 모든 room에 이 새 소켓을 실제로 재합류시킨다. global은
  // members 장부 대상이 아니므로(RQ-15 설계 결정) socket.join만 하고
  // 장부 갱신은 건너뛴다. user room은 이전(죽은) socket.id를 이 새
  // socket.id로 교체해 참여자 목록(RQ-15)이 끊김 없이 이어지게 한다 — 유예
  // 중엔 퇴장 정리가 아직 실행되지 않아 죽은 소켓 id가 그대로 남아
  // 있으므로, 교체하지 않으면 이후 broadcastParticipants가 그 id를 조회하지
  // 못해(io.sockets.sockets에 없음) 이 참여자가 사라진 것으로 잘못 표시된다.
  for (const room of session.rooms) {
    socket.join(room);
    if (room === GLOBAL_ROOM) continue;
    replaceMember(state, room, previousSocketId, socket.id);
  }

  const unread: Record<RoomName, number> = {};
  for (const room of session.rooms) {
    unread[room] = session.unread.get(room) ?? 0;
  }

  ack({ ok: true, nickname: session.nickname, rooms: [...session.rooms], activeRoom: session.activeRoom, unread });
}
