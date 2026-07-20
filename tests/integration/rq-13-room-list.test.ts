import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM, type RoomName, type ChatMessage } from '../../src/shared/types';

/**
 * RQ-13 (specs/requirements.md §2):
 * "시스템은 존재하는 모든 room의 목록을 모든 사용자에게 제공해야 한다. 동일
 * 이름의 room은 동시에 둘 이상 존재할 수 없다 (이름 = 고유 식별자)."
 *
 * 비범위 (requirements.md §3, task 지시):
 *   - 비공개/초대제 room.
 *   - room의 메모리 삭제 자체(자료구조에서 지우는 행위)는 RQ-12 스코프.
 *     이 RQ·이 파일은 "목록"(사용자에게 보이는 존재 room 집합)의 정확성만
 *     다룬다 — 빈 room이 목록에서 빠지기만 하면 되고, 서버 내부 자료구조에서
 *     그 room의 흔적이 언제 실제로 지워지는지는 검증하지 않는다.
 *
 * ── 정정 이력 ──
 *
 * 이 파일은 원래(커밋 5c5a5e9) GA-21/22/23을 "global은 목록에서 제외"로
 * 구현했고, 그 결정이 docs/adr/0004-global-channel.md 결과 섹션("room
 * 목록(RQ-13)에 global이 항상 표시된다")과 문면상 상충함을 스펙 노트로
 * 정직하게 남겼었다. team-lead 검토 결과 **ADR-0004(진실 공급원 #2)가
 * 이긴다**고 확인되어 골든(evals/golden/track-a-product.jsonl GA-21/22/23)이
 * "global 항상 포함"으로 정정됐고(커밋 9e2fe38), 신규 GA-24(예약 이름 거부)도
 * 함께 추가됐다. 이 커밋은 테스트를 정정된 골든에 맞춰 재정정한다 — 이제
 * ADR-0004·골든·테스트가 모두 일치하며, 이전 스펙 노트가 지적했던 상충은
 * 해소됐다(추가 후속 조치 불필요).
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-13):
 *   GA-21
 *     given : user-created room 없음 (user1·user2 접속, 각자 global 자동
 *             참여). 초기 존재 room 목록은 [global].
 *     when  : user1이 room-A 생성(참여)
 *     then  : user1과 room 미참여자 user2 모두 존재 room 목록 [global, room-A]를
 *             수신 — global은 상설 예약 room으로 항상 포함(ADR-0004 결과),
 *             미참여자 포함 전체 사용자에게 방송
 *     verify: integration_test
 *   GA-22
 *     given : user1이 room-A에 참여 중 (존재 room 목록 [global, room-A])
 *     when  : user2가 이름 room-A로 room 생성(참여) 시도
 *     then  : user2는 동일한 room-A에 합류(별도 room 미생성) — 이름=고유
 *             식별자, user1·user2가 같은 room에서 상호 수신; 목록은
 *             [global, room-A]로 room-A 중복 없음
 *     verify: integration_test
 *   GA-23
 *     given : room-A에 user1만 참여 (존재 room 목록 [global, room-A])
 *     when  : user1이 room-A를 떠나 room-A가 빈 상태
 *     then  : 전체 사용자가 존재 room 목록 [global]을 수신 — 빈 user room은
 *             목록에서 제외되나 global은 존속(ADR-0004 예외 2, 메모리 삭제
 *             자체는 RQ-12)
 *     verify: integration_test
 *   GA-24
 *     given : user1 접속(global 자동 참여). 별도 user room 미생성 — 존재
 *             room 목록은 [global] 뿐.
 *     when  : user1이 이름 'GLOBAL'(대소문자 무관)로 room 생성(참여) 시도
 *     then  : 서버가 거부 — 'global'은 예약 이름(ADR-0004 결정 3), 별도
 *             room 미생성 · 존재 room 목록 불변([global])
 *     verify: integration_test
 *
 * ── 기존 인프라 (이미 구현·머지됨) ──
 *
 * src/server/createChatServer.ts:
 *   join({room,nickname}, ack) — RQ-01. 이 소켓을 room에 합류시킨다. room
 *     이름은 이미 그 자체로 고유 식별자다(Socket.IO room = 이름으로 식별) —
 *     같은 이름으로 join하면 항상 같은 room에 합류한다. 이 원시 동작이
 *     GA-22("동일 이름 → 동일 room 합류")의 토대다.
 *   leave({room}, ack) — RQ-03. 이 소켓을 room에서 제거한다.
 *   RQ-15가 도입한 `roomMembers: Map<RoomName, string[]>` 장부 — join 순서로
 *     기록된 room별 현재 멤버(socket.id) 목록. **접속 시 자동 참여하는
 *     global(ADR-0004)은 이 장부에 포함되지 않는다**(RQ-15 설계 결정,
 *     createChatServer.ts의 RoomMembers 타입 주석 참고) — 이 사실 자체는 이
 *     정정에서도 바뀌지 않는다. 다만 "존재 room 목록"은 이제 이 장부의 키
 *     집합에 GLOBAL_ROOM을 항상 앞자리로 덧붙인 것이다(아래 신설 계약 참고).
 *   src/shared/types.ts의 `GLOBAL_ROOM = 'global'` 상수 — 예약된 상설 room
 *     이름(ADR-0004). 이 파일은 문자열 리터럴 'global'을 직접 쓰지 않고 이
 *     상수를 참조해 상수가 바뀌어도 테스트가 깨지지 않게 한다.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다. 아직 미구현, coder의 구현 대상) ──
 *
 * 이벤트: 서버→클라이언트 'rooms' 브로드캐스트/유니캐스트 (아래 참고).
 *   payload: { rooms: RoomName[] }
 *
 * 1) 목록 구성:
 *    - 배열의 0번 인덱스는 **항상 GLOBAL_ROOM**이다 — 접속자 수·user room
 *      존재 여부와 무관하게 상시 포함(ADR-0004 결과 "room 목록에 global이
 *      항상 표시된다"; RQ-12 예외로 참여자 0명이어도 global이 존속하는 것과
 *      같은 근거). GLOBAL_ROOM은 roomMembers 장부에서 조회하는 것이 아니라
 *      무조건 앞자리에 고정한다.
 *    - 이어서, 사용자가 생성한 room 중 현재 멤버가 1명 이상인 것을
 *      roomMembers 장부의 키 중 값 배열 길이 ≥ 1인 것 — 최초 멤버를 얻은
 *      순(생성순, Map 삽입 순서)으로 추가한다.
 *
 * 2) 발신 대상 — 두 경로:
 *    a. **변화 시 전역 방송**: "사용자 생성 room 집합" 자체가 바뀔 때(아래
 *       3번) 접속 중인 **모든** 소켓에게 io.emit으로 방송한다(room 멤버
 *       한정이 아니다 — RQ-15의 room-scoped `participants`와 다른 지점.
 *       GA-21의 "미참여자 user2도 수신"이 이를 요구한다). GLOBAL_ROOM 자체는
 *       앞자리에 고정이라 이 트리거와 무관하다(글로벌은 집합에 넣고 빼는
 *       대상이 아니므로 "글로벌이 추가/제거될 때"라는 트리거 자체가 없다).
 *    b. **신규 접속자 초기 전달**: 소켓이 새로 접속(connection)했을 때, 그
 *       순간의 목록 스냅샷을 그 소켓에게만(유니캐스트) 즉시 보낸다. 목록은
 *       이제 GLOBAL_ROOM을 항상 포함해 **결코 비지 않으므로**, "목록이
 *       비어있으면 생략"하던 구 계약의 분기는 도달 불가능해져 사실상
 *       무조건 전달로 단순화된다 — coder가 그 조건문 자체를 남겨두든
 *       제거하든 이 테스트가 요구하는 것은 관찰 가능한 결과(매 접속마다
 *       최소 [GLOBAL_ROOM]을 포함한 스냅샷을 즉시 수신)뿐이다.
 *
 * 3) 방송 트리거(2-a 경로) — "사용자 생성 room 집합"이 바뀌는 시점만:
 *    - room이 0명→1명이 되는 순간(최초 생성, join) → 집합에 추가.
 *    - room이 1명→0명이 되는 순간(마지막 멤버가 leave 또는 disconnect) →
 *      집합에서 제거.
 *    - 이미 존재하는 room에 2번째 이상 멤버가 join하거나, 아직 다른 멤버가
 *      남아 있는 room에서 누군가 leave하는 경우는 "집합" 자체가 바뀌지
 *      않으므로 이 이벤트를 새로 방송할 필요가 없다(강제하지 않음 — 방송
 *      해도 목록 내용 자체는 동일해야 하므로 테스트가 깨지지는 않지만, 이
 *      경로에 의존해 GA-22·GA-24를 검증하지 않는다 — 아래 4번 참고).
 *
 * 4) GA-22/GA-24 검증 방식(설계 결정): user2가 이미 존재하는 room-A에
 *    2번째로 join하는 것(GA-22)이나, 예약 이름으로 join이 거부되는 것
 *    (GA-24)은 위 3번에 의해 "집합 불변"이므로 새로운 'rooms' 방송이 반드시
 *    발생한다고 단정할 수 없다. 따라서 "목록이 특정 상태로 유지/불변됨"은
 *    방송을 기다리는 대신, 해당 시도 완료 **이후** 새로 접속하는 관찰자
 *    소켓이 2번 경로(신규 접속자 초기 전달)로 받는 스냅샷을 직접 확인해서
 *    검증한다 — 그 순간의 실제 서버 상태를 가장 직접적으로 관찰하는
 *    방법이다.
 *
 * 5) 순서: rooms 배열은 GLOBAL_ROOM이 항상 0번 인덱스, 그 뒤로 사용자 생성
 *    room이 **생성 순서**(그 room이 처음 1명째 멤버를 얻은 순서, 오름차순)로
 *    이어진다 — roomMembers Map의 삽입 순서(JS Map은 삽입 순서를 보장)와
 *    자연히 일치한다. 결정적 순서가 없으면 배열 비교 테스트가
 *    불안정해지므로(ADR-0005 테스트 가능성 요건) 이 세션이 고정한 설계
 *    결정이다. (RQ-15의 "퇴장 후 재참여 순서는 골든이 다루지 않아 강제하지
 *    않는다"와 동일한 정신으로) room이 비었다가 같은 이름으로 재생성될 때의
 *    순서는 이 테스트가 다루지 않는다.
 *
 * 6) GA-22의 "user1·user2가 같은 room에서 상호 수신"은 room 이름 문자열이
 *    같다는 것만으로 증명되지 않으므로(서버가 이름은 같게 취급하면서 내부
 *    자료구조는 분리하는 버그도 이론상 가능) 실제 'message' 상호 송수신으로
 *    직접 확인한다(RQ-01/02 기존 계약 재사용, 신규 계약 아님).
 *
 * 7) 예약 이름 거부(GA-24, ADR-0004 결정 3): join 요청의 room 필드가
 *    대소문자 무시 비교로 GLOBAL_ROOM과 일치하면 서버는 join을 거부한다 —
 *    ack `{ ok: false, error: string }` (기존 JoinAck `{ok:false, error}`
 *    패턴 재사용, 신규 shape 아님). 이때 socket.join 호출도, roomMembers
 *    갱신도, 'rooms' 방송도 발생하지 않는다 — "사용자 생성 room 집합"이
 *    전혀 바뀌지 않기 때문이다(위 3번과 동일 근거). 정확한 오류 메시지
 *    문구는 골든이 규정하지 않으므로 이 테스트는 문구를 단언하지 않고
 *    `error`가 string 타입이라는 것만 확인한다.
 *
 * 부정 단언은 이 파일에서 사용하지 않는다(모든 GA가 "수신함"을 요구하는
 * 양성 단언이다) — 상한 있는 대기(ADR-0005)만 사용한다. GA-22·GA-24의
 * "목록 불변/유지"도 "방송이 안 왔음"을 기다리는 대신 "관찰자가 특정
 * 스냅샷을 수신함"이라는 양성 단언으로 검증한다(위 4번).
 */

/** RQ-13 신설 계약 payload — 파일 상단 주석 참고. */
interface RoomsPayload {
  rooms: RoomName[];
}

/**
 * 'rooms' 이벤트를 timeoutMs 내에 기다린다. 'participants'(RQ-15)와 달리
 * room 필드로 걸러낼 필요가 없다 — 이 이벤트 자체가 room 하나가 아니라 "존재
 * room 집합 전체"를 담은 전역 신호이기 때문이다. 짧은 기본값(1500ms)을 쓰는
 * 이유: 한 테스트 안에서 이 대기를 여러 번 순차로 사용할 때 vitest.config.ts의
 * testTimeout(5000ms) 예산을 넘기지 않기 위함이다(Red 단계에서는 매번 만료까지
 * 채워서 대기하므로 누적 시간이 특히 중요하다) — 로컬 in-process 서버 기준
 * 정상 동작 시 응답은 수 ms 내로 오므로 이 단축이 Green 단계 신뢰성을 해치지
 * 않는다.
 */
function waitForRoomsEvent(socket: ClientSocket, timeoutMs = 1500): Promise<RoomsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('rooms', onRooms);
      reject(new Error(`'rooms' 이벤트가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    function onRooms(payload: RoomsPayload): void {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once('rooms', onRooms);
  });
}

/** 지정 이벤트가 timeoutMs 내에 오지 않으면 reject한다 — 상한 명시(ADR-0005). */
function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'${event}' 이벤트가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

type JoinAck = { ok: true } | { ok: false; error: string };

/** join emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForJoinAck(
  socket: ClientSocket,
  payload: { room: string; nickname: string },
  timeoutMs = 2000
): Promise<JoinAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'join' ack가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.emit('join', payload, (ack: JoinAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

type LeaveAck = { ok: true } | { ok: false; error: string };

/** leave emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForLeaveAck(
  socket: ClientSocket,
  payload: { room: string },
  timeoutMs = 2000
): Promise<LeaveAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'leave' ack가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.emit('leave', payload, (ack: LeaveAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/** 테스트마다 독립 서버를 기동해 접속 URL을 반환한다. 종료는 cleanupFns에 등록. */
async function startServer(cleanupFns: Array<() => void | Promise<void>>): Promise<string> {
  const { httpServer, io } = createChatServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
  return `http://localhost:${port}`;
}

/** 클라이언트 소켓을 접속시키고 disconnect를 cleanupFns에 등록한다. */
function connectClient(url: string, cleanupFns: Array<() => void | Promise<void>>): ClientSocket {
  const socket = ioClient(url, { forceNew: true });
  cleanupFns.push(() => {
    socket.disconnect();
  });
  return socket;
}

describe('RQ-13 / GA-21: room 생성 시 존재 room 목록이 미참여자를 포함한 전체 접속자에게 방송된다 (global 항상 포함)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A를 생성(참여)하면 user1과 room 미참여자 user2 모두 존재 room 목록 [global, room-A]를 수신한다 (RQ-13, GA-21)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user-created room 없음 (user1·user2 접속, 각자 global만 참여).
      // 접속 직후 신설 계약 2-b(신규 접속자 초기 전달)에 의해 각 소켓은 이미
      // [global] 스냅샷을 유니캐스트로 받았을 수 있다 — 하지만 그 시점에는
      // 아직 'rooms' 리스너를 등록하지 않았으므로(once는 등록 이후 발신만
      // 받는다) 그 이벤트는 그냥 소비되지 않은 채 지나간다. 아래에서 새로
      // 등록하는 리스너는 "when"에서 트리거하는 생성 방송만 받는다.

      // when: user1이 room-A를 생성(참여). 트리거(emit) 직전에 관찰자를
      // 동기적으로 등록해야 서버의 동기 처리 중 브로드캐스트를 놓치지 않는다.
      const user1SeesCreation = waitForRoomsEvent(user1);
      const user2SeesCreation = waitForRoomsEvent(user2);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);

      // then: user1(생성자 자신)·user2(미참여자) 모두 [global, room-A]를
      // 수신한다 — global이 항상 0번 인덱스(ADR-0004 결과).
      // Promise.allSettled로 두 수신 대기를 동시에 마무리한다(개별 순차 await
      // 시 앞선 것이 먼저 reject하면 뒤따르는 promise의 거부가 처리되지 않은
      // 채 새어나가는 것을 방지 — 기존 rq-04/rq-15 테스트와 동일 근거).
      const expected: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      const [user1Result, user2Result] = await Promise.allSettled([user1SeesCreation, user2SeesCreation]);

      function expectReceived(result: PromiseSettledResult<RoomsPayload>, who: string): void {
        if (result.status === 'rejected') {
          throw new Error(`${who} 수신 실패: ${String(result.reason)}`);
        }
        expect(result.value, who).toEqual(expected);
      }
      expectReceived(user1Result, 'user1(생성자 자신)');
      expectReceived(user2Result, 'user2(room-A 미참여자)');
    }
  );
});

describe('RQ-13 / GA-22: 동일 이름으로 room 생성을 시도하면 별도 room이 생기지 않고 동일 room에 합류한다 (이름 = 고유 식별자)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A 참여 중일 때 user2가 같은 이름 room-A로 참여를 시도하면 동일 room에 합류(상호 수신)하고, 존재 room 목록은 [global, room-A]로 유지된다 (RQ-13, GA-22)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1이 room-A에 참여 중 (존재 room 목록 [global, room-A]).
      const user1SeesCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedRooms: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      await expect(user1SeesCreation).resolves.toEqual(expectedRooms);

      // when: user2가 이름 room-A로 참여(생성) 시도. join의 기존 계약상
      // 같은 이름은 항상 같은 Socket.IO room으로 귀결되므로 ack는 성공해야
      // 한다 — "별도 room 미생성"의 1차 증거.
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // then (상호 수신): 이름이 같다는 것만으로는 "진짜 같은 room에
      // 합류했는가"를 증명하지 못하므로, 실제 메시지 상호 송수신으로 직접
      // 확인한다(신설 계약 6번).
      const user2ReceivesFromUser1 = waitForEvent<ChatMessage>(user2, 'message');
      user1.emit('message', { room: 'room-A', body: 'hi user2' });
      const expectedMsgToUser2: ChatMessage = { room: 'room-A', nickname: 'user1', body: 'hi user2' };
      await expect(user2ReceivesFromUser1).resolves.toEqual(expectedMsgToUser2);

      const user1ReceivesFromUser2 = waitForEvent<ChatMessage>(user1, 'message');
      user2.emit('message', { room: 'room-A', body: 'hi user1' });
      const expectedMsgToUser1: ChatMessage = { room: 'room-A', nickname: 'user2', body: 'hi user1' };
      await expect(user1ReceivesFromUser2).resolves.toEqual(expectedMsgToUser1);

      // then (목록은 [global, room-A]로 유지): user2의 join은 이미 존재하는
      // room-A의 멤버 수만 늘릴 뿐 "사용자 생성 room 집합" 자체를 바꾸지
      // 않으므로 새 'rooms' 방송이 반드시 발생한다고 단정할 수 없다(신설 계약
      // 3·4번). 방송을 기다리는 대신, 지금 새로 접속하는 관찰자(checker)가
      // 접속 즉시 받는 현재 목록 스냅샷(신설 계약 2-b)으로 "그 순간의 실제
      // 목록"을 직접 확인한다 — room-A가 정확히 1개만 있어야 한다(중복
      // 생성됐다면 [global,'room-A','room-A'] 같은 값이 되거나, 별도 room이
      // 생겼다면 다른 이름이 섞여 있을 것이다).
      const checker = connectClient(url, cleanupFns);
      const checkerSnapshot = await waitForRoomsEvent(checker);
      expect(checkerSnapshot).toEqual(expectedRooms);
    }
  );
});

describe('RQ-13 / GA-23: room의 마지막 참여자가 떠나면 빈 user room은 존재 room 목록에서 제외되나 global은 존속한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-A에 user1만 참여 중일 때 user1이 room-A를 떠나면, user1 자신과 room-A 비참여자 outsider 모두 존재 room 목록 [global]을 수신한다 (RQ-13, GA-23)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      // outsider: room-A에 한 번도 참여하지 않은 채 접속만 유지하는 관찰자
      // — GA-23의 "전체 사용자" 요구를 검증하는 대조군(GA-21과 동일 근거).
      const outsider = connectClient(url, cleanupFns);

      // given: room-A에 user1만 참여 (존재 room 목록 [global, room-A]). 생성
      // 방송 자체를 outsider도 받는지는 GA-21이 이미 검증했으므로 여기서는
      // given 상태를 만드는 user1의 수신만 확인한다(outsider의 'rooms'
      // 리스너는 아직 등록하지 않으므로 이 생성 이벤트는 outsider 쪽에서
      // 소비되지 않은 채 남는다 — 이후 "when" 단계에서 outsider에 새 리스너를
      // 등록해도 서로 간섭하지 않는다. once 리스너는 등록 시점 이후의 발신만
      // 받는다).
      const user1SeesCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedAfterJoin: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      await expect(user1SeesCreation).resolves.toEqual(expectedAfterJoin);

      // when: user1이 room-A를 떠나 room-A가 빈 상태가 된다(마지막 멤버
      // leave). 트리거(emit) 직전에 두 관찰자를 동기적으로 등록한다.
      const user1SeesEmptied = waitForRoomsEvent(user1);
      const outsiderSeesEmptied = waitForRoomsEvent(outsider);
      const leaveAck = await waitForLeaveAck(user1, { room: 'room-A' });
      expect(leaveAck.ok).toBe(true);

      // then: 전체 접속자(퇴장 당사자 user1·비참여자 outsider 모두)가 room-A
      // 없는 목록([global])을 수신한다 — 빈 user room은 목록에서 제외되나
      // global은 존속한다(ADR-0004 예외 2, 메모리 삭제 자체는 RQ-12 영역, 이
      // 테스트는 "목록"의 정확성만 본다).
      const expectedAfterLeave: RoomsPayload = { rooms: [GLOBAL_ROOM] };
      const [user1Result, outsiderResult] = await Promise.allSettled([user1SeesEmptied, outsiderSeesEmptied]);

      function expectReceived(result: PromiseSettledResult<RoomsPayload>, who: string): void {
        if (result.status === 'rejected') {
          throw new Error(`${who} 수신 실패: ${String(result.reason)}`);
        }
        expect(result.value, who).toEqual(expectedAfterLeave);
      }
      expectReceived(user1Result, 'user1(마지막 멤버, leave 당사자)');
      expectReceived(outsiderResult, 'outsider(room-A 비참여자)');
    }
  );
});

describe('RQ-13 / GA-24: 예약 이름(global, 대소문자 무관)으로 room 생성을 시도하면 서버가 거부하고 존재 room 목록이 불변한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    "user1이 이름 'GLOBAL'(대소문자 무관)로 room 생성(참여)을 시도하면 서버가 거부하고 별도 room이 생기지 않으며 존재 room 목록이 [global]로 불변한다 (RQ-13, GA-24)",
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);

      // given: user1 접속(global 자동 참여). 별도 user room 미생성 — 존재
      // room 목록은 [global] 뿐이다(이 given 자체는 아래 "파생, 골든 아님"
      // 테스트가 접속 즉시 관찰로 이미 핀 고정한다).

      // when: user1이 대문자 'GLOBAL'로 room 생성(참여) 시도.
      const ack = await waitForJoinAck(user1, { room: 'GLOBAL', nickname: 'user1' });

      // then: 서버가 거부한다 — ADR-0004 결정 3("'global'은 대소문자 무관
      // 예약 이름"). 정확한 오류 문구는 골든이 규정하지 않으므로 타입만
      // 확인한다(신설 계약 7번).
      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(typeof ack.error).toBe('string');
      }

      // then (별도 room 미생성 + 목록 불변): 거부된 join은 "사용자 생성 room
      // 집합"을 전혀 바꾸지 않으므로 새 'rooms' 방송이 발생한다고 단정할 수
      // 없다(신설 계약 3·4번, GA-22와 동일 근거). 방송을 기다리는 대신, 이후
      // 새로 접속하는 관찰자(checker)가 접속 즉시 받는 스냅샷으로 "그 순간의
      // 실제 목록"이 여전히 [global] 하나뿐임을 직접 확인한다 — 'GLOBAL'이라는
      // 별도 이름의 room이 생겼다면 [global, 'GLOBAL'] 같은 값이 되어 있을
      // 것이다.
      const checker = connectClient(url, cleanupFns);
      const checkerSnapshot = await waitForRoomsEvent(checker);
      const expected: RoomsPayload = { rooms: [GLOBAL_ROOM] };
      expect(checkerSnapshot).toEqual(expected);
    }
  );
});

describe('RQ-13 (파생, 골든 아님): 여러 room이 동시에 존재할 때 목록 순서는 global을 앞세운 생성 순서를 따른다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-21/22/23/24는 user room이 최대 하나(room-A)만 등장해
  // "user room이 여러 개일 때의 상호 순서"까지는 검증할 수 없다. RQ-13
  // EARS("존재하는 모든 room의 목록")는 동시에 여러 room이 존재할 수 있음을
  // 전제하므로, 목록 순서가 결정적이지 않으면 이 배열을 다루는 어떤
  // 테스트도(그리고 실제 UI도) 안정적으로 검증/렌더링할 수 없다(ADR-0005
  // 테스트 가능성 요건). 파일 상단 신설 계약 5번의 순서 규칙(global 항상
  // 0번, 이후 생성 순서)을 여기서 실제로 핀 고정한다.
  it(
    'user1이 room-A를 먼저 생성하고 user2가 이어서 room-B를 생성하면, 존재 room 목록은 [global, room-A, room-B] 순서로 방송된다 (RQ-13 파생, 골든 아님)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const user1SeesFirstCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedAfterFirst: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      await expect(user1SeesFirstCreation).resolves.toEqual(expectedAfterFirst);

      const user1SeesSecondCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);
      const expectedAfterSecond: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A', 'room-B'] };
      await expect(user1SeesSecondCreation).resolves.toEqual(expectedAfterSecond);
    }
  );
});

describe('RQ-13 (파생, 골든 아님): 이미 user room이 존재하는 상태에서 새로 접속한 소켓은 즉시 현재 목록을 수신한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-21/22/23/24 중 "이미 room이 존재하는 상태에서 새로 접속"을
  // 다루는 케이스가 없다. 그러나 RQ-13 EARS는 "모든 사용자에게 제공"이라고
  // 못박아, 변화 시점에 마침 접속해 있던 사용자만이 아니라 그 이후 접속하는
  // 사용자도 대상에 포함한다 — 신설 계약 2-b(신규 접속자 초기 전달)를
  // 여기서 직접 핀 고정한다. 이 메커니즘은 GA-22·GA-24 검증(체커 스냅샷)의
  // 전제이기도 하다.
  it(
    'room-A가 이미 존재하는 상태에서 새로 접속한 소켓은 join 없이도 즉시 존재 room 목록 [global, room-A]를 수신한다 (RQ-13 파생, 골든 아님)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);

      // 위 join으로 room-A가 이미 존재하는 상태가 된 뒤에 새로 접속한다.
      const newcomer = connectClient(url, cleanupFns);
      const initialSnapshot = await waitForRoomsEvent(newcomer);
      const expected: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      expect(initialSnapshot).toEqual(expected);
    }
  );
});

describe('RQ-13 (파생, 골든 아님): user room이 하나도 없어도 새로 접속한 소켓은 즉시 [global]을 수신한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — 이 케이스는 GA-21의 "given"(user-created room 없음, 초기
  // 목록 [global])을 그 자체로 관찰 가능한 결과로 직접 핀 고정한다. global
  // 제외 구 계약에서는 이 시점의 목록이 빈 배열이라 신규 접속자에게 아무것도
  // 보내지 않는 것이 정상이었다(신설 계약 2-b 구버전 "비어있으면 생략") —
  // 이번 정정으로 global이 항상 포함되어 목록이 결코 비지 않으므로, 이
  // 분기가 도달 불가능해졌다는 것 자체가 이번 정정의 핵심 차이다. 이 테스트는
  // 그 차이를 직접 검증해 "예전처럼 아무것도 안 옴"으로 되돌아가는 회귀를
  // 막는다.
  it(
    'room이 하나도 생성되지 않은 상태에서 접속한 소켓도 join 없이 즉시 존재 room 목록 [global]을 수신한다 (RQ-13 파생, 골든 아님)',
    async () => {
      const url = await startServer(cleanupFns);
      const newcomer = connectClient(url, cleanupFns);
      const initialSnapshot = await waitForRoomsEvent(newcomer);
      const expected: RoomsPayload = { rooms: [GLOBAL_ROOM] };
      expect(initialSnapshot).toEqual(expected);
    }
  );
});

describe('RQ-13 (파생, 골든 아님): 예약 이름 거부는 다른 대소문자 조합에도 동일하게 적용된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-24는 정확히 'GLOBAL'(전부 대문자) 한 가지 변형만
  // 명시한다. ADR-0004 결정 3의 "대소문자 무관"이 리터럴 'GLOBAL' 문자열과의
  // 단순 일치가 아니라 진짜 대소문자 무시 비교(예: toLowerCase 비교)로
  // 구현됐는지 확인하려면 다른 변형도 최소 1개 더 필요하다 — 부분 혼합
  // 대소문자('Global')로 동일한 거부 동작을 핀 고정한다.
  it(
    "user1이 이름 'Global'(부분 대소문자 혼합)로 room 생성을 시도해도 서버가 거부하고 목록이 [global]로 불변한다 (RQ-13 파생, 골든 아님)",
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);

      const ack = await waitForJoinAck(user1, { room: 'Global', nickname: 'user1' });
      expect(ack.ok).toBe(false);

      const checker = connectClient(url, cleanupFns);
      const checkerSnapshot = await waitForRoomsEvent(checker);
      const expected: RoomsPayload = { rooms: [GLOBAL_ROOM] };
      expect(checkerSnapshot).toEqual(expected);
    }
  );
});
