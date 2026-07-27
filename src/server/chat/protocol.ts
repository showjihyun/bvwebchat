// 이 서버가 전선(wire)에서 약속하는 것 전부 — 이벤트 이름, payload/ack shape,
// 소켓별 상태. **타입만** 있고 실행 코드가 없으므로 esbuild 번들에서 완전히
// 소거된다(ADR-0006 결정2).
//
// 클라이언트(`src/client/useChat.ts`)가 같은 shape을 손으로 복제해 유지한다 —
// 그 파일의 "서버 계약과 동일한 이벤트 shape" 주석이 가리키는 대상이 이
// 파일이다. 두 곳을 하나로 합치는 것(protocol을 src/shared로 승격)은
// 클라이언트 번들 그래프까지 건드리므로 별도 PR로 남긴다(ADR-0007 근거 절).
//
// 계층(ADR-0007 규칙2): L1 — shared/types와 socket.io 타입에만 의존한다.

import type { DefaultEventsMap, Server as SocketIOServer, Socket } from 'socket.io';
import type { ChatMessage, RoomName } from '../../shared/types';

/** 'join' 요청 payload — 참여할 room과 자칭 nickname을 선언한다 (RQ-01). */
export interface JoinPayload {
  room: RoomName;
  nickname: string;
}

/**
 * 'join' ack 콜백 결과. RQ-11: 성공 시 해당 room의 최근 메시지 히스토리
 * (오래된 것 → 최신 순)를 함께 반환한다. 참여 자체가 거부된 경우(ok:false)는
 * history가 없다 — 참여하지 못했으므로 히스토리도 없다 (test-writer 계약,
 * _workspace/RQ-11/01_test-writer_red.md §4).
 */
export type JoinAck = { ok: true; history: ChatMessage[] } | { ok: false; error: string };

/**
 * 'message' 요청 payload — nickname은 재전송하지 않는다. 서버가 join 시 이
 * 소켓에 연결한 nickname을 조회해 사용한다 (클라이언트 자칭 nickname을 매
 * 메시지마다 신뢰하지 않는다).
 */
export interface MessagePayload {
  room: RoomName;
  body: string;
}

/**
 * 'leave' 요청 payload (RQ-03) — nickname은 재전송하지 않는다. join으로 이미
 * socket.data에 연결된 nickname은 leave 후에도 유지된다(leave는 room
 * 멤버십만 해제한다).
 */
export interface LeavePayload {
  room: RoomName;
}

/** 'leave' ack 콜백 결과 — join과 동일한 shape으로 일관성을 유지한다. */
export type LeaveAck = { ok: true } | { ok: false; error: string };

/**
 * 'identify' 요청 payload (RQ-10) — 닉네임 입력만으로 사용자를 식별한다
 * (계정·비밀번호 필드 없음. nickname 단일 필드라는 것 자체가 계약이다).
 */
export interface IdentifyPayload {
  nickname: string;
}

/**
 * 'identify' ack 콜백 결과 — 고유화된 최종 nickname을 함께 반환한다 (RQ-10).
 * RQ-18 / ADR-0003 결정1-2: 성공 시 서버가 새로 발급한 불투명 세션 토큰을
 * 함께 반환한다. 기존(RQ-10) 계약은 그대로 유지되고 token 필드만 추가됐다.
 */
export type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };

/**
 * 'resume' 요청 payload (RQ-18 / ADR-0003 결정1-2·5) — identify가 발급한
 * 세션 토큰을 제시해 살아있는 세션(연결 중 또는 퇴장 유예 30초 이내)을
 * 이 소켓에 재바인딩한다.
 */
export interface ResumePayload {
  token: string;
}

/** 'resume' ack 콜백 결과 — 복원된 세션의 전체 상태를 담아 반환한다 (RQ-18). */
export type ResumeAck =
  | { ok: true; nickname: string; rooms: RoomName[]; activeRoom: RoomName | null; unread: Record<RoomName, number> }
  | { ok: false; error: string };

/**
 * 'activeRoom' 요청 payload (RQ-18 / ADR-0003 결정4) — 클라이언트가 현재
 * 보고 있는 room을 서버에 통지한다.
 */
export interface ActiveRoomPayload {
  room: string;
}

/** 'activeRoom' ack 콜백 결과 — 참여하지 않은 room이면 거부한다 (RQ-18). */
export type ActiveRoomAck = { ok: true } | { ok: false; error: string };

/**
 * 서버→클라이언트 'unread' 유니캐스트 payload (RQ-18) — 그 세션의 현재
 * 소켓에만 전달된다(room 전체 브로드캐스트가 아니다 — 사적 UI 상태).
 */
export interface UnreadPayload {
  room: RoomName;
  count: number;
}

/**
 * 서버→클라이언트 'participants' 브로드캐스트 payload (RQ-15). participants는
 * 표시 이름(닉네임) 배열이며, 해당 room에 먼저 join한 사람이 앞쪽에 온다
 * (참여 순, test-writer 계약 — tests/integration/rq-15-participants.test.ts).
 */
export interface ParticipantsPayload {
  room: RoomName;
  participants: string[];
}

/**
 * 서버→클라이언트 'rooms' 브로드캐스트/유니캐스트 payload (RQ-13). 배열 0번
 * 인덱스는 항상 GLOBAL_ROOM, 이어서 사용자 생성 room 중 현재 멤버 ≥ 1인 것을
 * 생성순으로 나열한다 (test-writer 계약 — tests/integration/rq-13-room-list.test.ts
 * 파일 상단 주석 §1, §5).
 */
export interface RoomsPayload {
  rooms: RoomName[];
}

export interface ClientToServerEvents {
  identify: (payload: IdentifyPayload, ack: (result: IdentifyAck) => void) => void;
  join: (payload: JoinPayload, ack: (result: JoinAck) => void) => void;
  message: (payload: MessagePayload) => void;
  leave: (payload: LeavePayload, ack: (result: LeaveAck) => void) => void;
  resume: (payload: ResumePayload, ack: (result: ResumeAck) => void) => void;
  activeRoom: (payload: ActiveRoomPayload, ack: (result: ActiveRoomAck) => void) => void;
}

export interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
  participants: (payload: ParticipantsPayload) => void;
  rooms: (payload: RoomsPayload) => void;
  unread: (payload: UnreadPayload) => void;
}

/** 소켓별 상태 — join 시 연결한 nickname (RQ-01 계약: message 전송 시 재전송하지 않음). */
export interface SocketData {
  nickname?: string;
  /**
   * identify가 이 소켓에 부여한 nickname (RQ-10). nicknamesInUse 점유 해제는
   * 이 값 기준으로 수행한다 — join이 이후 socket.data.nickname을 다른 값으로
   * 덮어써도(현재 테스트는 그러지 않지만) 점유 해제 대상이 흔들리지 않도록
   * join의 nickname과 분리해 추적한다.
   */
  identifiedNickname?: string;
  /**
   * RQ-18 / ADR-0003: 이 소켓에 identify(또는 resume)로 바인딩된 세션 토큰.
   * join/leave/message/activeRoom 핸들러가 이 값으로 세션 상태를 조회한다.
   * identify를 호출한 적 없는 소켓은 undefined로 유지되며, 이 경우 세션·
   * 안 읽음 집계 로직은 그냥 건너뛴다(세션리스 소켓 회귀 방지, 기존
   * RQ-01~15 동작 무변경).
   */
  token?: string;
}

/**
 * 제네릭 인자 순서는 공개 계약의 일부다 — 통합 테스트가
 * `ReturnType<typeof createChatServer>['io']`로 이 타입을 되받아
 * `io.sockets.sockets.get(id)` 같은 서버측 조작을 한다(rq-18, rq-12).
 * 순서가 바뀌면 tsc가 **테스트 파일 안에서** 실패한다.
 */
export type ChatServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
export type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
