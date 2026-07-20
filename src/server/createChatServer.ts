// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md

import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type DefaultEventsMap, type Socket } from 'socket.io';
import type { ChatMessage, RoomName } from '../shared/types';

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

interface ClientToServerEvents {
  join: (payload: JoinPayload, ack: (result: JoinAck) => void) => void;
  message: (payload: MessagePayload) => void;
}

interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
}

/** 소켓별 상태 — join 시 연결한 nickname (RQ-01 계약: message 전송 시 재전송하지 않음). */
interface SocketData {
  nickname?: string;
}

type ChatServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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

  io.on('connection', (socket) => {
    socket.on('join', (payload, ack) => handleJoin(socket, payload, ack));
    socket.on('message', (payload) => handleMessage(io, socket, payload));
  });

  return { httpServer, io };
}
