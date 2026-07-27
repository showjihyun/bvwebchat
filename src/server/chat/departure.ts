// 연결 종료의 시간축 — ADR-0003 결정5(퇴장 유예 30초) + ADR-0004 예외2
// (빈 room 정리에서 global 제외) + RQ-12(빈 room 실삭제)가 만나는 곳.
//
// 이 서버에서 **미래의 일을 예약하는 유일한 파일**이다. "타이머를 누가
// 소유하는가"가 한 번의 grep으로 답해지도록 별도 파일로 둔다(ADR-0007 규칙4).
// 실패 모드도 다른 파일과 다르다 — 여기가 틀리면 테스트가 "실패"하는 게
// 아니라 "멈춘다".
//
// ⚠️ 타이머 규칙 4가지. 어기면 ADR-0005 결정4(vi.useFakeTimers)가 무효가 된다:
//  1. `setTimeout`을 **전역으로 맨몸 호출**한다. `node:timers`에서 import
//     하거나 Clock/Timer DI 시임으로 감싸면 vi의 기본 fake timer가 그것을
//     패치하지 못해 rq-15 GA-20·rq-12 파생·rq-18 GA-14와 유예 만료 파생이
//     전부 timeout으로 죽는다(단언 diff 없이 여러 개가 동시에 — 워커 크래시
//     flake와 구별되는 별개 모집단이다).
//  2. `timer.unref()`를 유지한다. 빼면 단언은 그대로 통과하지만 vitest가
//     종료하지 못한다("something prevents Vite from exiting").
//  3. 클로저의 읽기 시점 비대칭을 유지한다 — `token`은 **스케줄 시점**
//     스냅샷(인자로 전달), `identifiedNickname`은 **발화 시점** 조회.
//     다른 소켓에서의 resume이 옛 소켓의 타이머로 엉뚱한 닉네임을 해제하는
//     것을 막는 장치다. finalizeDeparture의 인자 목록을 바꾸지 말 것.
//  4. io.close() 시 대기 중인 타이머를 정리하지 **않는다**(현행 유지).
//     정리는 행동 변경이며(확정됐어야 할 세션이 확정되지 않는다) 어떤
//     테스트도 요구하지 않는다. 필요해지면 ADR-0003 결정5의 후속으로 별도 처리.
//
// 계층(ADR-0007 규칙2): L5 — protocol·state·broadcast·session에 의존한다.
// room.ts와는 서로 import 하지 않는다(같은 계층, 간선 없음).

import type { RoomName } from '../../shared/types';
import type { ChatServer, ChatSocket } from './protocol';
import { deleteRoomState, GRACE_PERIOD_MS, removeMember, type ChatState } from './state';
import { broadcastParticipants, broadcastRooms } from './broadcast';
import { discardSession, markSessionDisconnected } from './session';

/**
 * RQ-15: 연결이 끊긴 소켓을 이 소켓이 join(RQ-01)으로 등록돼 있던 모든 room의
 * 멤버 순서 기록에서 제거하고, 각 room마다 갱신된 참여자 목록을 남은 멤버에게
 * 방송한다. Socket.IO의 'disconnect' 이벤트 시점엔 소켓이 이미 모든
 * Socket.IO room에서 빠진 뒤라 socket.rooms로는 소속 room을 알 수 없지만,
 * members는 서버가 직접 관리하는 별도 장부이므로 이 시점에도 소켓이
 * 어느 room들의 멤버였는지 안전하게 조회할 수 있다(test-writer 계약의
 * "disconnecting 이벤트로 스냅샷" 힌트 대신 택한 대안 — 자체 장부가 이미
 * 있으므로 추가 이벤트 리스너 없이 동일한 결과를 얻는다).
 *
 * 분해 전 이름은 handleDisconnect였다. 이제 'disconnect' 리스너가 아니라
 * 유예 만료 후의 정리 본체이므로 이름을 역할에 맞췄다.
 */
function purgeSocketFromRooms(io: ChatServer, state: ChatState, socket: ChatSocket): void {
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
  // 상태(members·histories)를 삭제한다. GLOBAL_ROOM은 members
  // 순회 대상에 애초에 등록되지 않으므로(RQ-15 설계 결정) 이 루프 자체에
  // 나타나지 않아 삭제 대상에서 구조적으로 제외된다.
  for (const room of emptiedRooms) {
    deleteRoomState(state, room);
  }
}

/**
 * 퇴장 유예(30초)가 resume 없이 만료됐을 때 실행되는 확정 처리 —
 * 기존(RQ-01~15) 즉시 퇴장 처리(nickname 해제·room 정리)를 그대로
 * 수행하고, 세션이 있었다면 그 세션(안 읽음 개수 포함)을 완전히 버린다
 * (ADR-0003 결정5 마지막 문장 — RQ-18 범위는 "참여 중인 room"이므로 퇴장이
 * 확정되면 더 이상 참여 중이 아니다).
 *
 * `token`은 인자로 받는다(스케줄 시점 스냅샷). `identifiedNickname`은 여기서
 * 직접 읽는다(발화 시점) — 파일 헤더 규칙3.
 */
function finalizeDeparture(io: ChatServer, state: ChatState, socket: ChatSocket, token: string | undefined): void {
  const heldNickname = socket.data.identifiedNickname;
  if (heldNickname !== undefined) {
    state.nicknamesInUse.delete(heldNickname);
  }
  purgeSocketFromRooms(io, state, socket);
  discardSession(state, token);
}

/**
 * RQ-18 / ADR-0003 결정5: 모든 socket disconnect에 적용되는 30초 퇴장
 * 유예를 스케줄한다 — 기존 즉시 퇴장 처리(nickname 해제·room 정리)를
 * 곧바로 실행하지 않고 이 타이머 만료 시점(finalizeDeparture)으로 미룬다.
 * 세션이 있는 소켓(identify 완료)이면 세션을 "연결 끊김" 상태로 표시하고
 * 타이머를 세션에 보관해 resume이 취소할 수 있게 한다. 세션이 없는 소켓
 * (identify 미호출)도 유예 자체는 동일하게 적용되지만, 취소할 세션이 없으므로
 * 타이머는 무조건 만료된다(세션리스 소켓도 유예 대상이라는 계약).
 * timer.unref()로 이 타이머가 프로세스 종료를 막지 않게 한다 — 유예를 취소
 * 하지 않는 시나리오(예: GA-27)에서 테스트/프로세스가 실제 30초를 불필요하게
 * 기다리지 않도록 하기 위함이며, 타이머가 실행되는 시점·동작에는 영향이 없다.
 */
export function scheduleDeparture(io: ChatServer, state: ChatState, socket: ChatSocket): void {
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
