// RQ-01 서버 계약 구현 — room 참여 시 수신자 목록 등록 (ADR-0001: Socket.IO).
// 계약 출처: tests/integration/rq-01-room-join.test.ts,
// _workspace/RQ-01/01_test-writer_red.md
//
// RQ-18(안 읽음 개수) / ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션
// 토큰) 계약 추가. 계약 출처: tests/integration/rq-18-unread.test.ts,
// _workspace/RQ-18/01_test-writer_red.md, docs/adr/0003-user-identity.md.

import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server as SocketIOServer, type DefaultEventsMap, type Socket } from 'socket.io';
import { GLOBAL_ROOM, type ChatMessage, type RoomName } from '../shared/types';

/** 'join' 요청 payload — 참여할 room과 자칭 nickname을 선언한다 (RQ-01). */
interface JoinPayload {
  room: RoomName;
  nickname: string;
}

/**
 * 'join' ack 콜백 결과. RQ-11: 성공 시 해당 room의 최근 메시지 히스토리
 * (오래된 것 → 최신 순)를 함께 반환한다. 참여 자체가 거부된 경우(ok:false)는
 * history가 없다 — 참여하지 못했으므로 히스토리도 없다 (test-writer 계약,
 * _workspace/RQ-11/01_test-writer_red.md §4).
 */
type JoinAck = { ok: true; history: ChatMessage[] } | { ok: false; error: string };

/** RQ-11 / ADR-0002: room당 보관할 최근 메시지 상한 (링버퍼, 초과 시 오래된 것부터 폐기). */
const MAX_ROOM_HISTORY = 50;

/** room별 최근 메시지 히스토리 (인메모리, ADR-0002 — 서버 재시작 시 소실 허용). */
type RoomHistories = Map<RoomName, ChatMessage[]>;

/**
 * room별 현재 멤버를 join 순서대로 기록한 socket.id 배열 (RQ-15). 참여자
 * "표시 이름" 자체가 아니라 socket.id를 저장하는 이유: Socket.IO room의
 * 내부 Set은 순서를 보장하지 않고(fetchSockets() 순서도 문서화되지 않음),
 * 동일 nickname을 가진 서로 다른 소켓이 같은 room에 있을 수도 있어(RQ-01의
 * join은 nickname 유일성을 강제하지 않는다) nickname만으로는 leave/disconnect
 * 시 "어떤 참여자가 빠졌는지"를 명확히 식별할 수 없다 — socket.id는 항상
 * 유일하므로 이 모호함이 없다. join 전용 room에만 등록한다(자동 참여하는
 * global room은 이 세션의 설계 결정으로 대상에서 제외 — test-writer 계약
 * "무관한 room ... 방송 여부는 이 테스트가 규정하지 않는다").
 */
type RoomMembers = Map<RoomName, string[]>;

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

/**
 * 'identify' ack 콜백 결과 — 고유화된 최종 nickname을 함께 반환한다 (RQ-10).
 * RQ-18 / ADR-0003 결정1-2: 성공 시 서버가 새로 발급한 불투명 세션 토큰을
 * 함께 반환한다. 기존(RQ-10) 계약은 그대로 유지되고 token 필드만 추가됐다.
 */
type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };

/**
 * 'resume' 요청 payload (RQ-18 / ADR-0003 결정1-2·5) — identify가 발급한
 * 세션 토큰을 제시해 살아있는 세션(연결 중 또는 퇴장 유예 30초 이내)을
 * 이 소켓에 재바인딩한다.
 */
interface ResumePayload {
  token: string;
}

/** 'resume' ack 콜백 결과 — 복원된 세션의 전체 상태를 담아 반환한다 (RQ-18). */
type ResumeAck =
  | { ok: true; nickname: string; rooms: RoomName[]; activeRoom: RoomName | null; unread: Record<RoomName, number> }
  | { ok: false; error: string };

/**
 * 'activeRoom' 요청 payload (RQ-18 / ADR-0003 결정4) — 클라이언트가 현재
 * 보고 있는 room을 서버에 통지한다.
 */
interface ActiveRoomPayload {
  room: string;
}

/** 'activeRoom' ack 콜백 결과 — 참여하지 않은 room이면 거부한다 (RQ-18). */
type ActiveRoomAck = { ok: true } | { ok: false; error: string };

/**
 * 서버→클라이언트 'unread' 유니캐스트 payload (RQ-18) — 그 세션의 현재
 * 소켓에만 전달된다(room 전체 브로드캐스트가 아니다 — 사적 UI 상태).
 */
interface UnreadPayload {
  room: RoomName;
  count: number;
}

/**
 * 서버→클라이언트 'participants' 브로드캐스트 payload (RQ-15). participants는
 * 표시 이름(닉네임) 배열이며, 해당 room에 먼저 join한 사람이 앞쪽에 온다
 * (참여 순, test-writer 계약 — tests/integration/rq-15-participants.test.ts).
 */
interface ParticipantsPayload {
  room: RoomName;
  participants: string[];
}

/**
 * 서버→클라이언트 'rooms' 브로드캐스트/유니캐스트 payload (RQ-13). 배열 0번
 * 인덱스는 항상 GLOBAL_ROOM, 이어서 사용자 생성 room 중 현재 멤버 ≥ 1인 것을
 * 생성순으로 나열한다 (test-writer 계약 — tests/integration/rq-13-room-list.test.ts
 * 파일 상단 주석 §1, §5).
 */
interface RoomsPayload {
  rooms: RoomName[];
}

interface ClientToServerEvents {
  identify: (payload: IdentifyPayload, ack: (result: IdentifyAck) => void) => void;
  join: (payload: JoinPayload, ack: (result: JoinAck) => void) => void;
  message: (payload: MessagePayload) => void;
  leave: (payload: LeavePayload, ack: (result: LeaveAck) => void) => void;
  resume: (payload: ResumePayload, ack: (result: ResumeAck) => void) => void;
  activeRoom: (payload: ActiveRoomPayload, ack: (result: ActiveRoomAck) => void) => void;
}

interface ServerToClientEvents {
  message: (payload: ChatMessage) => void;
  participants: (payload: ParticipantsPayload) => void;
  rooms: (payload: RoomsPayload) => void;
  unread: (payload: UnreadPayload) => void;
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
 * RQ-18 / ADR-0003: identify로 발급된 세션의 서버측 상태. 토큰이 진실
 * 공급원이며(결정3), 소켓은 이 상태에 대한 일시적 바인딩일 뿐이다 —
 * resume은 동일 세션을 다른 소켓에 재바인딩한다.
 */
interface SessionState {
  nickname: string;
  /** 이 세션이 참여 중인 room 집합 — global은 identify 시점부터 항상 포함(ADR-0004 결정1). */
  rooms: Set<RoomName>;
  /** ADR-0003 결정4: 세션당 활성 room은 하나, 첫 통지 전엔 null. */
  activeRoom: RoomName | null;
  /** room별 안 읽음 개수 — 아직 이벤트가 없던 room은 키가 없고 0으로 취급한다(지연 초기화). */
  unread: Map<RoomName, number>;
  /**
   * 이 세션에 마지막으로 바인딩된 socket.id. 유예(30초) 중에는 이미 끊긴
   * 소켓의 id가 그대로 남아 있을 수 있다 — connected로 "지금 살아있는
   * 연결을 가리키는가"를 구분하고, resume 시 roomMembers에서 이 값을 새
   * socket.id로 교체하는 데 쓴다.
   */
  socketId: string;
  /** socketId가 현재 살아있는(바인딩된) 연결을 가리키는지 여부. */
  connected: boolean;
  /** 유예(30초) 타이머 — resume이 도착하면 취소한다. 유예 중이 아니면 undefined. */
  graceTimer: NodeJS.Timeout | undefined;
}

/** 토큰별 세션 상태 장부 (인메모리, 서버 인스턴스마다 하나 — ADR-0002/0003과 일관). */
type Sessions = Map<string, SessionState>;

/** ADR-0003 결정5: 퇴장 유예 30초 — 모든 socket disconnect에 적용되는 일반 규칙. */
const GRACE_PERIOD_MS = 30_000;

type ChatServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * roomMembers에 기록된 순서대로 nickname을 조회해 해당 room 멤버 전원에게
 * 'participants' 이벤트를 방송한다 (RQ-15). 이미 연결이 끊긴 소켓(id가 남아
 * 있지만 io.sockets.sockets에 더 이상 없는 경우)이나 nickname이 아직 없는
 * 소켓은 결과 배열에서 제외한다.
 */
function broadcastParticipants(io: ChatServer, roomMembers: RoomMembers, room: RoomName): void {
  const memberIds = roomMembers.get(room) ?? [];
  const participants = memberIds
    .map((socketId) => io.sockets.sockets.get(socketId)?.data.nickname)
    .filter(isNonEmptyString);
  io.to(room).emit('participants', { room, participants });
}

/**
 * 존재 room 목록을 구성한다 (RQ-13). GLOBAL_ROOM은 roomMembers 장부 조회 없이
 * 무조건 0번 인덱스에 고정한다(ADR-0004 결과 — 접속자 수·user room 존재
 * 여부와 무관하게 상시 포함). 이어서 roomMembers 장부의 키 중 현재 멤버가
 * 1명 이상인 것만 Map 삽입 순서(= 생성순)로 덧붙인다 — 마지막 멤버가 떠나도
 * 장부에서 키 자체를 지우지는 않으므로(메모리 삭제는 RQ-12 스코프) 여기서
 * 멤버 수 필터로 "목록"에서만 제외한다.
 */
function computeRoomsList(roomMembers: RoomMembers): RoomName[] {
  const userRooms = [...roomMembers.entries()].filter(([, members]) => members.length > 0).map(([room]) => room);
  return [GLOBAL_ROOM, ...userRooms];
}

/**
 * 존재 room 목록을 접속 중인 모든 소켓에게 방송한다 (RQ-13, 신설 계약 2-a).
 * room 한정 방송인 broadcastParticipants와 달리 io.emit으로 전 접속자에게
 * 보낸다 — GA-21의 "room 미참여자도 수신"이 이를 요구한다.
 */
function broadcastRooms(io: ChatServer, roomMembers: RoomMembers): void {
  io.emit('rooms', { rooms: computeRoomsList(roomMembers) });
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
  sessions: Sessions,
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

  // RQ-18: 이 소켓이 이전에 이미 세션(토큰)을 발급받았다면(동일 소켓에서
  // identify 재호출) 그 세션은 더 이상 어떤 소켓에서도 재개될 수 없으므로
  // 버린다 — "새 신원 발급"은 항상 새 세션을 만든다는 의도적 분리
  // (ADR-0003 결정1-2, resume과의 유일한 차이).
  const previousToken = socket.data.token;
  if (previousToken !== undefined) {
    sessions.delete(previousToken);
  }

  const assigned = generateUniqueNickname(payload.nickname, nicknamesInUse);
  nicknamesInUse.add(assigned);
  socket.data.identifiedNickname = assigned;
  socket.data.nickname = assigned;

  // RQ-18 / ADR-0003 결정1-2: 서버 발급 불투명 세션 토큰을 부여하고 세션
  // 상태를 초기화한다. global은 모든 소켓이 접속 즉시 자동 참여하므로
  // (ADR-0004 결정1) 세션의 참여 room 집합에도 처음부터 포함시킨다 —
  // GA-16이 요구하는 "global도 안 읽음 집계 대상"의 전제.
  const token = randomUUID();
  socket.data.token = token;
  sessions.set(token, {
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

/** RQ-01 본체: 이 소켓을 room의 수신자 목록에 추가한다 (Socket.IO room = 수신자 목록). */
function handleJoin(
  io: ChatServer,
  socket: ChatSocket,
  histories: RoomHistories,
  roomMembers: RoomMembers,
  sessions: Sessions,
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
  if (payload.room.toLowerCase() === GLOBAL_ROOM) {
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
  const history = histories.get(payload.room) ?? [];
  ack({ ok: true, history: [...history] });

  // RQ-18 / ADR-0003: 이 소켓에 바인딩된 세션이 있으면(identify를 호출한
  // 소켓만) 이 room을 세션의 참여 room 집합에 추가한다 — 이후 이 room에
  // 도착하는 메시지가 안 읽음 집계 대상이 된다(활성 room이 아닐 때).
  // 세션 없는 소켓(identify 미호출)은 이 로직을 건너뛰어 기존 RQ-01~15
  // 동작을 그대로 유지한다(세션리스 소켓 회귀 방지).
  const joinToken = socket.data.token;
  if (joinToken !== undefined) {
    const session = sessions.get(joinToken);
    if (session !== undefined) {
      session.rooms.add(payload.room);
    }
  }

  // RQ-15: 이 room의 멤버 순서 기록에 이 소켓을 추가한다(참여 순 — 맨 뒤에
  // append). RQ-13: 이 join 직전에 멤버가 0명(키 부재 포함)이었는지를 먼저
  // 확인해 둔다 — "사용자 생성 room 집합"에 새로 추가되는 순간(0→1 전이)인지
  // 판단하는 데 쓴다(신설 계약 3번).
  const existingMembers = roomMembers.get(payload.room);
  const isNewUserRoom = existingMembers === undefined || existingMembers.length === 0;
  const members = existingMembers ?? [];
  members.push(socket.id);
  roomMembers.set(payload.room, members);

  // room이 비어 있다가 이 join으로 최초 멤버(1명)가 된 경우는 방송을
  // 생략한다 — 알려야 할 "기존 멤버"가 아직 존재하지 않기 때문이다(설계
  // 결정). 이 생략은 관찰 가능한 계약(GA-19/20)에 영향을 주지 않을 뿐 아니라
  // 실제로 필요하다: 이 방송을 항상 보내면, 이후 두 번째 참여자가 들어올 때
  // 첫 번째 참여자가 등록하는 리스너(참여 순간 직전 등록)가 그 사이 뒤늦게
  // 도착하는 "1인 방송" 패킷을 대신 소비해 버려 다음 방송을 놓치는 경합이
  // 실측으로 재현된다(join ack와 참여자 방송이 별도 네트워크 왕복이라 도착
  // 순서가 보장되지 않음). 멤버가 2명 이상일 때만 방송하면 이 경합이
  // 구조적으로 사라진다.
  if (members.length > 1) {
    broadcastParticipants(io, roomMembers, payload.room);
  }

  // RQ-13: 이 join으로 "사용자 생성 room 집합"이 바뀌었다면(0→1 전이) 존재
  // room 목록을 전 접속자에게 방송한다(GA-21). participants와 달리 room
  // 미참여자도 대상이므로 broadcastParticipants와 별개로 io.emit 경로를 쓴다.
  if (isNewUserRoom) {
    broadcastRooms(io, roomMembers);
  }
}

/** join으로 등록된 nickname을 조회해 room 멤버 전원에게 브로드캐스트한다. */
function handleMessage(
  io: ChatServer,
  socket: ChatSocket,
  histories: RoomHistories,
  sessions: Sessions,
  payload: MessagePayload
): void {
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
  // 저장한다 (기존 브로드캐스트 로직은 변경하지 않는다). history 변수를
  // 그대로 재사용해(신규 room이든 기존이든) 아래 RQ-18 상한 계산이 별도
  // map 재조회 없이 항상 최신 길이를 참조하게 한다.
  let history = histories.get(payload.room);
  if (history === undefined) {
    history = [];
    histories.set(payload.room, history);
  }
  history.push(message);
  if (history.length > MAX_ROOM_HISTORY) {
    history.shift();
  }

  // RQ-18 / ADR-0003 결정4: 이 room에 참여 중인(global 포함) 세션 중 이
  // room이 활성 room이 아닌 세션의 안 읽음을 1 증가시켜 유니캐스트로
  // 통지한다. 상한(범위 제약 ②, GA-17)은 이 room이 현재 보관한 메시지 수
  // (방금 갱신한 링버퍼 길이, ADR-0002 상한 50)로 클램프한다 — 열었을 때
  // 이미 밀려나 볼 수 없는 메시지는 세지 않는다는 요구와 일치한다.
  const cap = history.length;
  for (const session of sessions.values()) {
    if (!session.rooms.has(payload.room)) continue;
    if (session.activeRoom === payload.room) continue;
    const current = session.unread.get(payload.room) ?? 0;
    const next = Math.min(current + 1, cap);
    session.unread.set(payload.room, next);
    if (session.connected) {
      io.to(session.socketId).emit('unread', { room: payload.room, count: next });
    }
  }
}

/** RQ-03 본체: 이 소켓을 room의 수신자 목록에서 제거한다 (Socket.IO room = 수신자 목록). */
function handleLeave(
  io: ChatServer,
  socket: ChatSocket,
  histories: RoomHistories,
  roomMembers: RoomMembers,
  sessions: Sessions,
  payload: LeavePayload,
  ack: (result: LeaveAck) => void
): void {
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

  // RQ-18 / ADR-0003 결정4: 이 소켓에 세션이 있으면 참여 room 집합·안 읽음
  // 기록에서 이 room을 제거한다. 이 room이 활성 room이었다면 활성 room은
  // 다시 없음(null)으로 되돌아간다(파생 테스트로 검증).
  const leaveToken = socket.data.token;
  if (leaveToken !== undefined) {
    const session = sessions.get(leaveToken);
    if (session !== undefined) {
      session.rooms.delete(payload.room);
      session.unread.delete(payload.room);
      if (session.activeRoom === payload.room) {
        session.activeRoom = null;
      }
    }
  }

  // RQ-15: 이 room의 멤버 순서 기록에서 이 소켓을 제거하고 갱신된 참여자
  // 목록을 남은 room 멤버 전원에게 방송한다. RQ-13: 이 제거로 멤버가 0명이
  // 됐다면("사용자 생성 room 집합"에서 제거되는 1→0 전이) 존재 room 목록도
  // 전 접속자에게 방송한다(GA-23, 신설 계약 3번).
  const members = roomMembers.get(payload.room);
  let becameEmptyUserRoom = false;
  if (members !== undefined) {
    const index = members.indexOf(socket.id);
    if (index !== -1) {
      members.splice(index, 1);
      if (members.length === 0) {
        becameEmptyUserRoom = true;
      }
    }
  }
  broadcastParticipants(io, roomMembers, payload.room);
  if (becameEmptyUserRoom) {
    broadcastRooms(io, roomMembers);
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
    roomMembers.delete(payload.room);
    histories.delete(payload.room);
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
function handleDisconnect(io: ChatServer, socket: ChatSocket, histories: RoomHistories, roomMembers: RoomMembers): void {
  let userRoomSetChanged = false;
  // RQ-12: 이 disconnect로 완전히 빈 room이 된 것들을 모아 뒀다가 루프 종료
  // 후 한 번에 삭제한다(순회 중인 Map을 직접 변형하지 않기 위함 — 한 소켓이
  // 여러 room의 마지막 멤버였을 수 있다).
  const emptiedRooms: RoomName[] = [];
  for (const [room, members] of roomMembers) {
    const index = members.indexOf(socket.id);
    if (index === -1) continue;
    members.splice(index, 1);
    broadcastParticipants(io, roomMembers, room);
    // RQ-13: 이 room이 이 disconnect로 0명이 됐다면 "사용자 생성 room 집합"이
    // 바뀐 것이다(1→0 전이) — 존재 room 목록 방송이 필요하다는 표시만 남기고
    // 계속 순회한다(한 소켓이 여러 room의 마지막 멤버였을 수 있으므로 방송은
    // 루프 종료 후 한 번만 보낸다).
    if (members.length === 0) {
      userRoomSetChanged = true;
      emptiedRooms.push(room);
    }
  }
  if (userRoomSetChanged) {
    broadcastRooms(io, roomMembers);
  }

  // RQ-12 / ADR-0004 예외 2: 위 방송이 모두 끝난 뒤 완전히 빈 room의 서버
  // 상태(roomMembers·roomHistories)를 삭제한다. GLOBAL_ROOM은 roomMembers
  // 순회 대상에 애초에 등록되지 않으므로(RQ-15 설계 결정) 이 루프 자체에
  // 나타나지 않아 삭제 대상에서 구조적으로 제외된다.
  for (const room of emptiedRooms) {
    roomMembers.delete(room);
    histories.delete(room);
  }
}

/**
 * RQ-18 본체 — activeRoom(payload:{room}, ack) (ADR-0003 결정4). 세션이 없는
 * 소켓(identify 미호출)에는 활성 room 개념 자체가 성립하지 않으므로 거부한다.
 * 참여하지 않은 room을 통지하면 거부하고 활성 room은 불변이다(GA-18, GA-10과
 * 동일 원칙 — 격리는 서버가 강제한다).
 */
function handleActiveRoom(
  socket: ChatSocket,
  sessions: Sessions,
  payload: ActiveRoomPayload,
  ack: (result: ActiveRoomAck) => void
): void {
  const token = socket.data.token;
  if (token === undefined) {
    ack({ ok: false, error: '세션이 없다 — 먼저 identify로 세션을 발급받아야 한다' });
    return;
  }
  const session = sessions.get(token);
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
  socket.emit('unread', { room: payload.room, count: 0 });
}

/**
 * RQ-18 본체 — resume(payload:{token}, ack) (ADR-0003 결정1-2·5). 살아있는
 * 세션(연결 중 또는 유예 30초 이내)이면 이 소켓에 세션을 재바인딩하고,
 * 참여 중이던 모든 room(global 포함)에 이 소켓을 실제로 재합류(socket.join)
 * 시켜 이후 메시지 라우팅·참여자 목록(RQ-15)이 끊김 없이 이어지게 한다.
 * 대기 중인 퇴장 확정 타이머(scheduleDeparture)를 취소한다.
 */
function handleResume(
  socket: ChatSocket,
  sessions: Sessions,
  roomMembers: RoomMembers,
  payload: ResumePayload,
  ack: (result: ResumeAck) => void
): void {
  const token = payload?.token;
  if (!isNonEmptyString(token)) {
    ack({ ok: false, error: 'token은 비어 있지 않은 문자열이어야 한다' });
    return;
  }
  const session = sessions.get(token);
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
  // roomMembers 장부 대상이 아니므로(RQ-15 설계 결정) socket.join만 하고
  // 장부 갱신은 건너뛴다. user room은 이전(죽은) socket.id를 이 새
  // socket.id로 교체해 참여자 목록(RQ-15)이 끊김 없이 이어지게 한다 — 유예
  // 중엔 handleDisconnect가 아직 실행되지 않아 죽은 소켓 id가 그대로 남아
  // 있으므로, 교체하지 않으면 이후 broadcastParticipants가 그 id를 조회하지
  // 못해(io.sockets.sockets에 없음) 이 참여자가 사라진 것으로 잘못 표시된다.
  for (const room of session.rooms) {
    socket.join(room);
    if (room === GLOBAL_ROOM) continue;
    const members = roomMembers.get(room);
    if (members === undefined) {
      roomMembers.set(room, [socket.id]);
      continue;
    }
    const staleIndex = members.indexOf(previousSocketId);
    if (staleIndex !== -1) {
      members[staleIndex] = socket.id;
    } else if (!members.includes(socket.id)) {
      members.push(socket.id);
    }
  }

  const unread: Record<RoomName, number> = {};
  for (const room of session.rooms) {
    unread[room] = session.unread.get(room) ?? 0;
  }

  ack({ ok: true, nickname: session.nickname, rooms: [...session.rooms], activeRoom: session.activeRoom, unread });
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
function scheduleDeparture(
  io: ChatServer,
  socket: ChatSocket,
  histories: RoomHistories,
  roomMembers: RoomMembers,
  nicknamesInUse: Set<string>,
  sessions: Sessions
): void {
  const token = socket.data.token;
  const session = token !== undefined ? sessions.get(token) : undefined;

  const timer = setTimeout(() => {
    finalizeDeparture(io, socket, histories, roomMembers, nicknamesInUse, sessions, token);
  }, GRACE_PERIOD_MS);
  timer.unref();

  if (session !== undefined) {
    session.connected = false;
    session.graceTimer = timer;
  }
}

/**
 * 퇴장 유예(30초)가 resume 없이 만료됐을 때 실행되는 확정 처리 —
 * 기존(RQ-01~15) 즉시 퇴장 처리(nickname 해제·handleDisconnect)를 그대로
 * 수행하고, 세션이 있었다면 그 세션(안 읽음 개수 포함)을 완전히 버린다
 * (ADR-0003 결정5 마지막 문장 — RQ-18 범위는 "참여 중인 room"이므로 퇴장이
 * 확정되면 더 이상 참여 중이 아니다).
 */
function finalizeDeparture(
  io: ChatServer,
  socket: ChatSocket,
  histories: RoomHistories,
  roomMembers: RoomMembers,
  nicknamesInUse: Set<string>,
  sessions: Sessions,
  token: string | undefined
): void {
  const heldNickname = socket.data.identifiedNickname;
  if (heldNickname !== undefined) {
    nicknamesInUse.delete(heldNickname);
  }
  handleDisconnect(io, socket, histories, roomMembers);
  if (token !== undefined) {
    sessions.delete(token);
  }
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

  // RQ-10: 현재 identify로 점유된 nickname 집합 (인메모리, ADR-0002와 일관 —
  // 서버 프로세스 생존 동안만 유지, 재시작 시 소실). 서버 인스턴스마다 하나.
  const nicknamesInUse = new Set<string>();

  // RQ-11 / ADR-0002: room별 최근 메시지 링버퍼 (인메모리, 서버 인스턴스마다 하나).
  const roomHistories: RoomHistories = new Map();

  // RQ-15: room별 현재 멤버(socket.id, join 순서) 장부. join(handleJoin)으로
  // 등록된 room만 대상이다 — 접속 시 자동 참여하는 global(ADR-0004)은
  // 여기 포함하지 않는다(설계 결정, 파일 상단 RoomMembers 주석 참고).
  const roomMembers: RoomMembers = new Map();

  // RQ-18 / ADR-0003: 토큰별 세션 상태(닉네임·참여 room·활성 room·안 읽음·
  // 유예 타이머) 장부. 인메모리, 서버 인스턴스마다 하나 — ADR-0002/0003과
  // 일관(서버 재시작 시 소실).
  const sessions: Sessions = new Map();

  io.on('connection', (socket) => {
    // ADR-0004 결정 1: 모든 접속 사용자는 global에 자동 참여하며 탈퇴할 수
    // 없다. nickname은 설정하지 않는다 — 수신은 room 멤버십만으로 충분하고,
    // nickname은 발신(handleMessage)에만 필요하다.
    socket.join(GLOBAL_ROOM);

    // RQ-13 신설 계약 2-b: 신규 접속자에게 그 순간의 존재 room 목록 스냅샷을
    // 유니캐스트로 즉시 전달한다. GLOBAL_ROOM이 항상 포함돼 목록이 결코
    // 비지 않으므로 조건 없이 항상 보낸다.
    socket.emit('rooms', { rooms: computeRoomsList(roomMembers) });

    socket.on('identify', (payload, ack) => handleIdentify(socket, nicknamesInUse, sessions, payload, ack));
    socket.on('join', (payload, ack) => handleJoin(io, socket, roomHistories, roomMembers, sessions, payload, ack));
    socket.on('message', (payload) => handleMessage(io, socket, roomHistories, sessions, payload));
    socket.on('leave', (payload, ack) => handleLeave(io, socket, roomHistories, roomMembers, sessions, payload, ack));
    // RQ-18: 활성 room 통지(ADR-0003 결정4)·세션 복원(결정1-2·5) — 세션이
    // 없는 소켓(identify 미호출)에서 호출되면 각 핸들러가 ok:false로 거부한다.
    socket.on('activeRoom', (payload, ack) => handleActiveRoom(socket, sessions, payload, ack));
    socket.on('resume', (payload, ack) => handleResume(socket, sessions, roomMembers, payload, ack));

    // RQ-10/RQ-15(기존) + RQ-18/ADR-0003 결정5(신설): 연결 종료 시 기존 즉시
    // 퇴장 처리(nickname 해제·participants/rooms 갱신·RQ-12 빈 room 삭제)를
    // 곧바로 실행하지 않고 30초 유예를 둔다 — 그 안에 동일 세션 토큰으로
    // resume이 오면 타이머가 취소되어 이 처리가 전혀 실행되지 않는다(GA-14).
    // 유예가 만료되면 finalizeDeparture가 기존 즉시 처리 전체를 실행하고,
    // 세션이 있었다면 그 안 읽음 개수까지 함께 버린다(ADR-0003 결정5).
    socket.on('disconnect', () => {
      scheduleDeparture(io, socket, roomHistories, roomMembers, nicknamesInUse, sessions);
    });
  });

  return { httpServer, io };
}
