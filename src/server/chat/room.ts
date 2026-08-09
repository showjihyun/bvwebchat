// room 참여·격리·히스토리·목록 — RQ-01(join) / RQ-02(격리) / RQ-03(leave) /
// RQ-11(히스토리 50) / RQ-13(room 목록) / RQ-15(참여자 목록).
//
// 앞으로 room 모양의 요구사항(비공개 room, room 이름 변경, room별 설정)은
// 전부 여기로 떨어진다 — 그게 이 경계의 이유다.
//
// handleMessage가 다섯 줄로 읽히는 것이 이 분해의 목표다:
//   격리 검증(RQ-02) → io.to().emit(RQ-02/04) → appendMessage(ADR-0002)
//   → fanOutUnread(cap)(ADR-0003 결정4)
//   → fanOutGlobalToJoinedRooms(RQ-04 v1.2 / ADR-0009, global일 때만)
// cap이 appendMessage의 반환값에서 곧바로 흘러가므로 GA-17의 상한과
// 링버퍼 길이가 서로 어긋날 수 없다.
//
// 다섯 번째 줄은 **이름 있는 함수로 뽑았다**. 인라인으로 두면 이 열거가
// handleMessage가 하는 일을 다 적지 못해 거짓이 되고, 머리 주석만 읽는
// 사람이 팬아웃을 못 본다 — 문서가 코드에 뒤처지는 R1 형상이 src/ 안에서
// 나는 자리다(2026-08-08 리뷰 S-1).
//
// 계층(ADR-0007 규칙2): L5 — protocol·state·validation·broadcast·session에
// 의존한다. session.ts는 여기를 되돌아 import 하지 않는다(단방향).

import { GLOBAL_ROOM, type ChatMessage } from '../../shared/types';
import type { ChatServer, ChatSocket, JoinAck, JoinPayload, LeaveAck, LeavePayload, MessagePayload } from './protocol';
import { addMember, appendMessage, deleteRoomState, removeMember, type ChatState } from './state';
import { isNonEmptyString, isReservedRoomNameForCreation } from './validation';
import { broadcastParticipants, broadcastRooms } from './broadcast';
import { attachRoomToSession, detachRoomFromSession, fanOutUnread } from './session';

/** RQ-01 본체: 이 소켓을 room의 수신자 목록에 추가한다 (Socket.IO room = 수신자 목록). */
export function handleJoin(
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
export function handleMessage(io: ChatServer, state: ChatState, socket: ChatSocket, payload: MessagePayload): void {
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

  if (payload.room === GLOBAL_ROOM) {
    fanOutGlobalToJoinedRooms(io, state, message);
  }
}

/**
 * RQ-04-a / ADR-0009: global 메시지를 **수신자가 참여 중인 각 room 안에도** 표시한다(결정1).
 *
 * `handleMessage`가 GLOBAL_ROOM 자신에 대해 이미 emit·appendMessage·fanOutUnread를
 * 끝낸 **뒤에** 호출된다 — #global 채널 동작은 건드리지 않는다(결정3).
 *
 * **대상 room은 `state.members`의 키를 그대로 쓴다.** global은 이 장부에 애초에 등록되지
 * 않으므로(state.ts `RoomMembers` 주석: "자동 참여하는 global room은 … 대상에서 제외")
 * global을 거르는 조건문이 따로 필요 없다 — 쓰면 그 전제가 바뀌는 날 조용히 틀린다.
 * room 단위 emit이 그 room 멤버에게만 가므로 **이 순회 자체가** "수신자가 참여 중인
 * room만"이라는 범위 제약(결정1, GA-38)을 만족한다: 서버에 존재하는 모든 room이 아니라
 * 멤버가 있는 room만 이 장부에 있다.
 *
 * **`fanOutUnread`를 부르지 않는다**(결정5, GA-40). 각 room의 안 읽음은 그대로 두고
 * GLOBAL_ROOM 자체의 안 읽음만 오른다. 전달·이력 저장과 안 읽음 집계를 여기서 분리하는
 * 것이 이 변경에서 **가장 틀리기 쉬운 지점**이다 — 앞의 둘을 복사하다 보면 셋째도
 * 복사하는 것이 자연스러워 보인다.
 */
function fanOutGlobalToJoinedRooms(io: ChatServer, state: ChatState, message: ChatMessage): void {
  for (const room of state.members.keys()) {
    // ADR-0009 결정4: 사본은 room 원본과 구별되는 표시(origin)를 싣는다 —
    // 원본 message 객체에는 붙이지 않는다(그건 그대로 #global로 나갔다).
    const copy: ChatMessage = { ...message, room, origin: 'global' };
    io.to(room).emit('message', copy);
    // 결정2: 이 room의 링버퍼에도 저장해 재접속 후에도 남는다(GA-39).
    // 반환값(post-append 길이)은 쓰지 않는다 — 안 읽음을 올리지 않으므로 상한 클램프가 없다.
    appendMessage(state, room, copy);
  }
}

/** RQ-03 본체: 이 소켓을 room의 수신자 목록에서 제거한다 (Socket.IO room = 수신자 목록). */
export function handleLeave(
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
