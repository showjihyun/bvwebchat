// 서버 인스턴스 하나가 소유하는 가변 장부 전체, 그리고 그 장부에 허용된
// 연산 전체. ADR-0002(링버퍼 50)·ADR-0003(세션 상태)의 상수가 사는 곳이다.
//
// **[PURE]** — socket.io를 타입으로도 import 하지 않는다(ADR-0007 규칙3,
// eslint no-restricted-imports로 기계 강제). io/socket 인자를 받지 않으므로
// 서버 기동 없이 단위 테스트할 수 있다.
//
// **모듈 스코프 가변 바인딩 금지**(ADR-0007 규칙1). 이 파일에서 `new Map()`·
// `new Set()`이 나타나도 되는 유일한 위치는 createChatState 안이다. 여기를
// 어기면 ESM 모듈 캐싱이 서버 인스턴스 간에 장부를 공유해, 테스트 파일당
// 8~11개씩 띄우는 서버들이 서로 오염된다(rq-13 GA-21이 먼저 깨진다).
//
// 계층(ADR-0007 규칙2): L2 — shared/types에만 의존한다.

import { GLOBAL_ROOM, type ChatMessage, type RoomName } from '../../shared/types';

/** RQ-11 / ADR-0002: room당 보관할 최근 메시지 상한 (링버퍼, 초과 시 오래된 것부터 폐기). */
export const MAX_ROOM_HISTORY = 50;

/** ADR-0003 결정5: 퇴장 유예 30초 — 모든 socket disconnect에 적용되는 일반 규칙. */
export const GRACE_PERIOD_MS = 30_000;

/** room별 최근 메시지 히스토리 (인메모리, ADR-0002 — 서버 재시작 시 소실 허용). */
export type RoomHistories = Map<RoomName, ChatMessage[]>;

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
export type RoomMembers = Map<RoomName, string[]>;

/**
 * RQ-18 / ADR-0003: identify로 발급된 세션의 서버측 상태. 토큰이 진실
 * 공급원이며(결정3), 소켓은 이 상태에 대한 일시적 바인딩일 뿐이다 —
 * resume은 동일 세션을 다른 소켓에 재바인딩한다.
 */
export interface SessionState {
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
   * 연결을 가리키는가"를 구분하고, resume 시 members에서 이 값을 새
   * socket.id로 교체하는 데 쓴다.
   */
  socketId: string;
  /** socketId가 현재 살아있는(바인딩된) 연결을 가리키는지 여부. */
  connected: boolean;
  /**
   * 유예(30초) 타이머 — resume이 도착하면 취소한다. 유예 중이 아니면 undefined.
   * 핸들이 세션 안에 있으므로 타이머 소유권도 서버 인스턴스별로 갈린다
   * (ADR-0007 규칙4). 타이머를 **만드는** 곳은 departure.ts 하나뿐이다.
   */
  graceTimer: NodeJS.Timeout | undefined;
}

/** 토큰별 세션 상태 장부 (인메모리, 서버 인스턴스마다 하나 — ADR-0002/0003과 일관). */
export type Sessions = Map<string, SessionState>;

/**
 * 서버 인스턴스 하나가 소유하는 가변 장부 전체 (ADR-0007 규칙1).
 * 필드는 readonly — 참조는 고정이고 Map/Set 내용만 제자리에서 변형된다.
 */
export interface ChatState {
  readonly histories: RoomHistories;
  readonly members: RoomMembers;
  readonly sessions: Sessions;
  readonly nicknamesInUse: Set<string>;
}

/**
 * 서버 인스턴스 1개분의 빈 장부를 새로 만든다 — createChatServer 호출마다
 * 정확히 한 번 호출된다(ADR-0007 규칙1: "1 서버 = 1 장부").
 *
 * - `histories` RQ-11 / ADR-0002: room별 최근 메시지 링버퍼.
 * - `members` RQ-15: room별 현재 멤버(socket.id, join 순서). join으로 등록된
 *   room만 대상이다 — 접속 시 자동 참여하는 global(ADR-0004)은 여기 포함하지
 *   않는다(설계 결정, RoomMembers 주석 참고).
 * - `sessions` RQ-18 / ADR-0003: 토큰별 세션 상태(닉네임·참여 room·활성 room·
 *   안 읽음·유예 타이머) 장부.
 * - `nicknamesInUse` RQ-10: 현재 identify로 점유된 nickname 집합.
 *
 * 전부 인메모리이며 ADR-0002와 일관되게 서버 프로세스 생존 동안만 유지된다.
 */
export function createChatState(): ChatState {
  return {
    histories: new Map(),
    members: new Map(),
    sessions: new Map(),
    nicknamesInUse: new Set(),
  };
}

/**
 * RQ-11 / ADR-0002: room 히스토리 링버퍼에 메시지 1건을 덧붙이고, **덧붙인
 * 뒤의** 보관 개수를 반환한다. 상한(MAX_ROOM_HISTORY=50)을 넘으면 가장
 * 오래된 것부터 폐기한다.
 *
 * 반환값이 "post-append 길이"라는 점이 계약이다 — RQ-18 GA-17의 안 읽음
 * 상한이 이 값을 그대로 클램프 상한으로 쓴다. pre-append 길이를 반환하면
 * 50번째 메시지에서 49가 되어 GA-17이 깨진다.
 */
export function appendMessage(state: ChatState, room: RoomName, message: ChatMessage): number {
  let history = state.histories.get(room);
  if (history === undefined) {
    history = [];
    state.histories.set(room, history);
  }
  history.push(message);
  if (history.length > MAX_ROOM_HISTORY) {
    history.shift();
  }
  return history.length;
}

/**
 * 존재 room 목록을 구성한다 (RQ-13). GLOBAL_ROOM은 members 장부 조회 없이
 * 무조건 0번 인덱스에 고정한다(ADR-0004 결과 — 접속자 수·user room 존재
 * 여부와 무관하게 상시 포함). 이어서 members 장부의 키 중 현재 멤버가
 * 1명 이상인 것만 Map 삽입 순서(= 생성순)로 덧붙인다 — 마지막 멤버가 떠나도
 * 장부에서 키 자체를 지우지는 않으므로(메모리 삭제는 RQ-12 스코프) 여기서
 * 멤버 수 필터로 "목록"에서만 제외한다.
 */
export function listRooms(state: ChatState): RoomName[] {
  const userRooms = [...state.members.entries()].filter(([, members]) => members.length > 0).map(([room]) => room);
  return [GLOBAL_ROOM, ...userRooms];
}

/**
 * RQ-15: room의 멤버 순서 기록 맨 뒤에 이 소켓을 덧붙인다(참여 순).
 *
 * 반환하는 두 값은 각각 서로 다른 방송을 게이팅하며, **읽는 시점이 다르다**:
 * - `isNewUserRoom` — push **직전**에 멤버가 0명(키 부재 포함)이었는가.
 *   "사용자 생성 room 집합"의 0→1 전이이며 RQ-13 GA-21의 'rooms' 방송 조건이다.
 *   push 뒤에 계산하면 매 join마다 참이 되어 전 접속자에게 헛방송이 나간다.
 * - `memberCount` — push **직후**의 멤버 수. RQ-15의 "1인일 때 participants
 *   방송 생략" 조건(> 1)이 이 값을 쓴다. 순서를 뒤집으면 조건이 반전된다.
 */
export function addMember(
  state: ChatState,
  room: RoomName,
  socketId: string
): { isNewUserRoom: boolean; memberCount: number } {
  const existingMembers = state.members.get(room);
  const isNewUserRoom = existingMembers === undefined || existingMembers.length === 0;
  const members = existingMembers ?? [];
  members.push(socketId);
  state.members.set(room, members);
  return { isNewUserRoom, memberCount: members.length };
}

/**
 * RQ-15: room의 멤버 순서 기록에서 이 소켓을 제거한다(남은 멤버의 상대 순서는
 * 유지 — splice).
 *
 * `removed`가 false면 이 소켓은 애초에 이 room의 멤버가 아니었다는 뜻이고,
 * 그때 `becameEmpty`는 **반드시 false**다. 이 전제(구 handleLeave의
 * `index !== -1` 가드)를 잃으면, 참여한 적 없는 room에 대해서도 "비었다"가
 * 참이 되어 RQ-12의 room 상태 삭제가 잘못 발동한다.
 */
export function removeMember(
  state: ChatState,
  room: RoomName,
  socketId: string
): { removed: boolean; becameEmpty: boolean } {
  const members = state.members.get(room);
  if (members === undefined) {
    return { removed: false, becameEmpty: false };
  }
  const index = members.indexOf(socketId);
  if (index === -1) {
    return { removed: false, becameEmpty: false };
  }
  members.splice(index, 1);
  return { removed: true, becameEmpty: members.length === 0 };
}

/**
 * RQ-18 / RQ-15: resume 시 room 멤버 기록의 죽은 socket.id를 새 socket.id로
 * **제자리에서** 교체한다.
 *
 * 제자리 교체(인덱스 대입)여야 하는 이유: 참여자 목록은 join 순서를 그대로
 * 표시하므로(RQ-15), 제거 후 push로 바꾸면 재접속한 사람이 목록 맨 뒤로
 * 밀려 순서가 관찰 가능하게 달라진다.
 *
 * 죽은 id가 없으면(이미 정리됐거나 유예가 만료된 뒤) 중복만 피해 덧붙이고,
 * 장부에 room 키 자체가 없으면 이 소켓 하나로 새로 만든다.
 */
export function replaceMember(state: ChatState, room: RoomName, staleSocketId: string, socketId: string): void {
  const members = state.members.get(room);
  if (members === undefined) {
    state.members.set(room, [socketId]);
    return;
  }
  const staleIndex = members.indexOf(staleSocketId);
  if (staleIndex !== -1) {
    members[staleIndex] = socketId;
  } else if (!members.includes(socketId)) {
    members.push(socketId);
  }
}

/**
 * RQ-12 / ADR-0004 예외 2: 완전히 빈 user room의 서버 상태를 장부에서
 * 지운다(멤버 배열 + 히스토리).
 *
 * **호출 순서가 계약이다** — 반드시 관련 방송(participants/rooms)을 모두
 * 보낸 **뒤에** 호출한다. 방송 시점엔 멤버 배열이 이미 비어 있어(length 0)
 * 결과가 같지만, 삭제를 앞당기면 listRooms·broadcastParticipants가 보는
 * 장부가 달라진다. 통합 테스트는 이 순서 뒤바뀜을 잡지 못한다(listRooms의
 * 멤버 수 필터가 빈 키를 어차피 제외하므로 목록 결과가 동일하다) — 규율로만
 * 보존되는 지점이다.
 *
 * GLOBAL_ROOM은 애초에 members 장부에 등록되지 않으므로(RQ-15 설계 결정)
 * 이 함수의 대상이 될 수 없다 — ADR-0004 결정1의 "global은 삭제되지 않는다"가
 * 별도 분기 없이 구조적으로 보장된다.
 */
export function deleteRoomState(state: ChatState, room: RoomName): void {
  state.members.delete(room);
  state.histories.delete(room);
}
