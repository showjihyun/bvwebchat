// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md

import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type DefaultEventsMap, type Socket } from 'socket.io';
import { GLOBAL_ROOM, type ChatMessage, type RoomName } from '../shared/types';

/** 'join' 요청 payload — 참여할 room과 자칭 nickname을 선언한다 (RQ-01). */
interface JoinPayload {
  room: RoomName;
  nickname: string;
}

/** 'join' ack 콜백 결과. */
type JoinAck = { ok: true } | { ok: false; error: string };

/**
 * 'message' 요청 payload — nickname은 재전송하지 않는다. 서버가 join 시 이
 * 소켓에 연결한 nickname을 조회해 사용한다 (클라이언트 자칭 nickname을 매
 * 메시지마다 신뢰하지 않는다).
 */
interface MessagePayload {
  room: RoomName;
  body: string;
}

/**
 * 'leave' 요청 payload (RQ-03) — nickname은 재전송하지 않는다. join으로 이미
 * socket.data에 연결된 nickname은 leave 후에도 유지된다(leave는 room
 * 멤버십만 해제한다).
 */
interface LeavePayload {
  room: RoomName;
}

/** 'leave' ack 콜백 결과 — join과 동일한 shape으로 일관성을 유지한다. */
type LeaveAck = { ok: true } | { ok: false; error: string };

/**
 * 'identify' 요청 payload (RQ-10) — 닉네임 입력만으로 사용자를 식별한다
 * (계정·비밀번호 필드 없음. nickname 단일 필드라는 것 자체가 계약이다).
 */
interface IdentifyPayload {
  nickname: string;
}

/** 'identify' ack 콜백 결과 — 고유화된 최종 nickname을 함께 반환한다 (RQ-10). */
type IdentifyAck = { ok: true; nickname: string } | { ok: false; error: string };

interface ClientToServerEvents {
  identify: (payload: IdentifyPayload, ack: (result: IdentifyAck) => void) => void;
  join: (payload: JoinPayload, ack: (result: JoinAck) => void) => void;
  message: (payload: MessagePayload) => void;
  leave: (payload: LeavePayload, ack: (result: LeaveAck) => void) => void;
}

interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
}

/** 소켓별 상태 — join 시 연결한 nickname (RQ-01 계약: message 전송 시 재전송하지 않음). */
interface SocketData {
  nickname?: string;
  /**
   * identify가 이 소켓에 부여한 nickname (RQ-10). nicknamesInUse 점유 해제는
   * 이 값 기준으로 수행한다 — join이 이후 socket.data.nickname을 다른 값으로
   * 덮어써도(현재 테스트는 그러지 않지만) 점유 해제 대상이 흔들리지 않도록
   * join의 nickname과 분리해 추적한다.
   */
  identifiedNickname?: string;
}

type ChatServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * identify 전용 검증 — 공백만으로 이뤄진 nickname도 "닉네임 미입력"으로
 * 취급한다 (rq-10-nickname-identity.test.ts 파일 상단 계약 주석 "비어있는
 * 문자열(또는 공백만)"). join/leave의 isNonEmptyString은 그대로 둔다(무변경).
 */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * base가 미점유면 그대로, 점유 중이면 "base-2", "base-3", ... 형태로 최초로
 * 비어 있는 접미사를 찾아 반환한다 (RQ-10 GA-11). 형식은 스펙이 강제하지
 * 않으므로(원문 "예: alice-2") 이 구분자·시작값을 이 세션의 설계 결정으로
 * 확정한다.
 */
function generateUniqueNickname(base: string, nicknamesInUse: ReadonlySet<string>): string {
  if (!nicknamesInUse.has(base)) {
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (nicknamesInUse.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
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
function handleIdentify(
  socket: ChatSocket,
  nicknamesInUse: Set<string>,
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
    nicknamesInUse.delete(previouslyHeld);
  }

  const assigned = generateUniqueNickname(payload.nickname, nicknamesInUse);
  nicknamesInUse.add(assigned);
  socket.data.identifiedNickname = assigned;
  socket.data.nickname = assigned;
  ack({ ok: true, nickname: assigned });
}

/** RQ-01 본체: 이 소켓을 room의 수신자 목록에 추가한다 (Socket.IO room = 수신자 목록). */
function handleJoin(socket: ChatSocket, payload: JoinPayload, ack: (result: JoinAck) => void): void {
  if (!isNonEmptyString(payload?.room) || !isNonEmptyString(payload?.nickname)) {
    ack({ ok: false, error: 'room과 nickname은 비어 있지 않은 문자열이어야 한다' });
    return;
  }

  socket.join(payload.room);
  socket.data.nickname = payload.nickname;
  ack({ ok: true });
}

/** join으로 등록된 nickname을 조회해 room 멤버 전원에게 브로드캐스트한다. */
function handleMessage(io: ChatServer, socket: ChatSocket, payload: MessagePayload): void {
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
}

/** RQ-03 본체: 이 소켓을 room의 수신자 목록에서 제거한다 (Socket.IO room = 수신자 목록). */
function handleLeave(socket: ChatSocket, payload: LeavePayload, ack: (result: LeaveAck) => void): void {
  if (!isNonEmptyString(payload?.room)) {
    ack({ ok: false, error: 'room은 비어 있지 않은 문자열이어야 한다' });
    return;
  }

  // ADR-0004 결정 1: global은 예약된 상설 room이며 탈퇴할 수 없다. 멤버십은
  // 유지한 채 ack만 거부해 클라이언트가 "나갔다"고 오인하지 않게 한다.
  if (payload.room === GLOBAL_ROOM) {
    ack({ ok: false, error: 'global room은 탈퇴할 수 없다' });
    return;
  }

  socket.leave(payload.room);
  ack({ ok: true });
}

/**
 * RQ-01 서버 계약. 반환된 httpServer는 listen()되지 않은 상태다 — 포트 결정은
 * 호출자 책임 (테스트는 0을 지정해 임의 포트를 배정받는다).
 */
export function createChatServer(): {
  httpServer: HttpServer;
  io: ChatServer;
} {
  const httpServer = createServer();
  const io: ChatServer = new SocketIOServer(httpServer);

  // RQ-10: 현재 identify로 점유된 nickname 집합 (인메모리, ADR-0002와 일관 —
  // 서버 프로세스 생존 동안만 유지, 재시작 시 소실). 서버 인스턴스마다 하나.
  const nicknamesInUse = new Set<string>();

  io.on('connection', (socket) => {
    // ADR-0004 결정 1: 모든 접속 사용자는 global에 자동 참여하며 탈퇴할 수
    // 없다. nickname은 설정하지 않는다 — 수신은 room 멤버십만으로 충분하고,
    // nickname은 발신(handleMessage)에만 필요하다.
    socket.join(GLOBAL_ROOM);

    socket.on('identify', (payload, ack) => handleIdentify(socket, nicknamesInUse, payload, ack));
    socket.on('join', (payload, ack) => handleJoin(socket, payload, ack));
    socket.on('message', (payload) => handleMessage(io, socket, payload));
    socket.on('leave', (payload, ack) => handleLeave(socket, payload, ack));

    // RQ-10: 연결 종료 시 이 소켓이 identify로 점유했던 nickname을 해제한다 —
    // 해제하지 않으면 재접속마다 접미사가 무한 누적된다(GA-11 고유화 규칙이
    // 점유 집합 크기에 비례해 영구히 커짐).
    socket.on('disconnect', () => {
      const heldNickname = socket.data.identifiedNickname;
      if (heldNickname !== undefined) {
        nicknamesInUse.delete(heldNickname);
      }
    });
  });

  return { httpServer, io };
}
