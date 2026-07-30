// 방출 지점 — 어떤 이벤트가 **누구에게** 가는지 한 파일에서 읽힌다.
//
// 이 서버에는 서로 다른 청중이 4가지 있고, 이들을 구별하는 것이 이 파일의
// 존재 이유다. 하나로 합치면 통합 테스트가 곧바로 잡아낸다(rq-13 GA-21/24,
// rq-12 GA-27):
//
//   participants  → io.to(room)  : room 한정 (RQ-15)
//   rooms(방송)   → io.emit      : 전 접속자 — room 미참여자도 받아야 한다(RQ-13 GA-21)
//   rooms(스냅샷) → socket.emit  : 갓 접속한 소켓 1개 유니캐스트 (RQ-13 계약 2-b)
//   unread        → 유니캐스트   : 그 세션의 현재 소켓에만 (RQ-18, 사적 UI 상태)
//
// 계층(ADR-0007 규칙2): L3 — protocol(타입)·state·validation에 의존한다.

import type { ChatServer, ChatSocket, UnreadPayload } from './protocol';
import { listRooms, type ChatState } from './state';
import { isNonEmptyString } from './validation';
import type { RoomName } from '../../shared/types';

/**
 * members에 기록된 순서대로 nickname을 조회해 해당 room 멤버 전원에게
 * 'participants' 이벤트를 방송한다 (RQ-15). 이미 연결이 끊긴 소켓(id가 남아
 * 있지만 io.sockets.sockets에 더 이상 없는 경우)이나 nickname이 아직 없는
 * 소켓은 결과 배열에서 제외한다 — 이 필터를 빼면 유예(30초) 중인 죽은
 * 소켓이 참여자 목록에 남는다(rq-15 GA-20이 잡는다).
 */
export function broadcastParticipants(io: ChatServer, state: ChatState, room: RoomName): void {
  const memberIds = state.members.get(room) ?? [];
  const participants = memberIds
    .map((socketId) => io.sockets.sockets.get(socketId)?.data.nickname)
    .filter(isNonEmptyString);
  io.to(room).emit('participants', { room, participants });
}

/**
 * 존재 room 목록을 접속 중인 **모든** 소켓에게 방송한다 (RQ-13, 신설 계약 2-a).
 * room 한정 방송인 broadcastParticipants와 달리 io.emit을 쓴다 — GA-21의
 * "room 미참여자도 수신"이 이를 요구한다.
 */
export function broadcastRooms(io: ChatServer, state: ChatState): void {
  io.emit('rooms', { rooms: listRooms(state) });
}

/**
 * 갓 접속한 소켓 하나에게 그 순간의 존재 room 목록 스냅샷을 유니캐스트한다
 * (RQ-13 신설 계약 2-b). broadcastRooms와 **경로가 분리돼 있어야 한다** —
 * rq-13 GA-24는 새 관찰자의 접속 시점 스냅샷으로 "목록이 바뀌지 않았음"을
 * 단언하므로, 이걸 io.emit으로 합치면 그 단언이 무의미해진다.
 */
export function emitRoomsSnapshot(socket: ChatSocket, state: ChatState): void {
  socket.emit('rooms', { rooms: listRooms(state) });
}

/**
 * RQ-18: 특정 세션의 현재 socket.id로 안 읽음 개수를 유니캐스트한다.
 * room 전체 방송이 아니다 — 안 읽음은 사적 UI 상태다.
 */
export function emitUnreadToSocketId(io: ChatServer, socketId: string, payload: UnreadPayload): void {
  io.to(socketId).emit('unread', payload);
}

/** RQ-18 GA-13: 방금 활성 room으로 통지한 그 소켓에게 0을 되돌려준다. */
export function emitUnreadToSocket(socket: ChatSocket, payload: UnreadPayload): void {
  socket.emit('unread', payload);
}
