import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { RoomName, ChatMessage } from '../../src/shared/types';

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
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-13):
 *   GA-21
 *     given : user-created room 없음 (user1·user2 접속, 각자 global만 참여)
 *     when  : user1이 room-A 생성(참여)
 *     then  : user1과 room 미참여자 user2 모두 존재 room 목록 [room-A]를 수신
 *             — 목록은 미참여자 포함 전체 사용자에게 방송
 *     verify: integration_test
 *   GA-22
 *     given : user1이 room-A에 참여 중 (존재 room 목록 [room-A])
 *     when  : user2가 이름 room-A로 room 생성(참여) 시도
 *     then  : user2는 동일한 room-A에 합류(별도 room 미생성) — 이름=고유
 *             식별자, user1·user2가 같은 room에서 상호 수신; 목록은 room-A
 *             1개 유지
 *     verify: integration_test
 *   GA-23
 *     given : room-A에 user1만 참여 (존재 room 목록 [room-A])
 *     when  : user1이 room-A를 떠나 room-A가 빈 상태
 *     then  : 전체 사용자가 room-A 없는 존재 room 목록을 수신 — 빈 room은
 *             목록에서 제외 (메모리 삭제 자체는 RQ-12)
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
 *     createChatServer.ts의 RoomMembers 타입 주석 참고). 따라서 이 장부의
 *     키 집합이 곧 "사용자가 만든 room 중 현재 멤버가 있는 room"이며, 이
 *     파일이 정의하는 "존재 room 목록"의 자연스러운 데이터 원천이다 — 이
 *     RQ는 이 장부에 새로 기록하는 것이 없고, 오직 이 장부의 변화를 관찰해
 *     방송하기만 하면 된다.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다. 아직 미구현, coder의 구현 대상) ──
 *
 * 이벤트: 서버→클라이언트 'rooms' 브로드캐스트/유니캐스트 (아래 참고).
 *   payload: { rooms: RoomName[] }
 *
 * 1) 목록 구성:
 *    - rooms는 "현재 멤버가 1명 이상인, 사용자가 만든 room" 이름 문자열
 *      배열이다 — roomMembers 장부의 키 중 값 배열 길이 ≥ 1인 것.
 *    - GLOBAL_ROOM('global')은 **제외**한다. 근거: global은 접속 시 자동
 *      참여하는 특수 room이라 "골라서 들어가는/만드는 room"이 아니고(RQ-04,
 *      ADR-0004), roomMembers 장부 자체가 애초에 global을 추적하지 않는다
 *      (RQ-15 설계 결정 — 위 참고). GA-21의 "then"이 명시하는 정확한 배열이
 *      [room-A](즉 [global, room-A]가 아님)라는 점도 이 설계와 일치한다.
 *      ⚠ 이 결정과 docs/adr/0004-global-channel.md의 결과 섹션("room
 *      목록(RQ-13)에 global이 항상 표시된다")이 문면상 어긋난다 — 상세는
 *      파일 하단 "스펙 노트" 참고(차단 아님, 후속 ADR 정정 권고 사항으로만
 *      기록).
 *
 * 2) 발신 대상 — 두 경로:
 *    a. **변화 시 전역 방송**: "존재 room 집합" 자체가 바뀔 때(아래 3번)
 *       접속 중인 **모든** 소켓에게 io.emit으로 방송한다(room 멤버 한정이
 *       아니다 — RQ-15의 room-scoped `participants`와 다른 지점. GA-21의
 *       "미참여자 user2도 수신"이 이를 요구한다).
 *    b. **신규 접속자 초기 전달**: 소켓이 새로 접속(connection)했을 때, 그
 *       순간 존재 room 목록이 **비어 있지 않으면** 그 소켓에게만(유니캐스트)
 *       현재 목록을 즉시 보낸다. 목록이 비어 있으면 아무것도 보내지 않는다
 *       — RQ-15가 "founding 1인째 join은 참여자 방송을 생략한다"고 결정한
 *       것과 동일한 근거(정보가 없는 이벤트를 접속마다 보내는 낭비를 피하고,
 *       RQ-16의 동시 접속 규모에서 무의미한 트래픽을 만들지 않는다). GA-21은
 *       "user-created room 없음" 상태에서 시작하므로 이 경로가 전혀
 *       발동하지 않는다 — GA-21 테스트가 접속 직후 별도의 "초기 빈 목록"
 *       이벤트를 기다리지 않는 이유다. 이 경로는 GA-22 검증(아래 4번)과
 *       "파생, 골든 아님" 테스트에서만 관찰된다.
 *
 * 3) 방송 트리거(2-a 경로) — "존재 room 집합"이 바뀌는 시점만:
 *    - room이 0명→1명이 되는 순간(최초 생성, join) → 집합에 추가.
 *    - room이 1명→0명이 되는 순간(마지막 멤버가 leave 또는 disconnect) →
 *      집합에서 제거.
 *    - 이미 존재하는 room에 2번째 이상 멤버가 join하거나, 아직 다른 멤버가
 *      남아 있는 room에서 누군가 leave하는 경우는 "집합" 자체가 바뀌지
 *      않으므로 이 이벤트를 새로 방송할 필요가 없다(강제하지 않음 — 방송
 *      해도 목록 내용 자체는 동일해야 하므로 테스트가 깨지지는 않지만, 이
 *      경로에 의존해 GA-22를 검증하지 않는다 — 아래 4번 참고).
 *
 * 4) GA-22 검증 방식(설계 결정): user2가 이미 존재하는 room-A에 2번째로
 *    join하는 것은 위 3번에 의해 "집합 불변"이므로 새로운 'rooms' 방송이
 *    반드시 발생한다고 단정할 수 없다. 따라서 "목록은 room-A 1개 유지"는
 *    방송을 기다리는 대신, user2의 join 완료 **이후** 새로 접속하는 관찰자
 *    소켓이 2번 경로(신규 접속자 초기 전달)로 받는 스냅샷을 직접 확인해서
 *    검증한다 — 그 순간의 실제 서버 상태를 가장 직접적으로 관찰하는 방법이다.
 *
 * 5) 순서: rooms 배열은 **생성 순서**(그 room이 처음 1명째 멤버를 얻은
 *    순서, 오름차순)를 따른다 — roomMembers Map의 삽입 순서(JS Map은 삽입
 *    순서를 보장)와 자연히 일치한다. 결정적 순서가 없으면 배열 비교
 *    테스트가 불안정해지므로(ADR-0005 테스트 가능성 요건) 이 세션이 고정한
 *    설계 결정이다. (RQ-15의 "퇴장 후 재참여 순서는 골든이 다루지 않아
 *    강제하지 않는다"와 동일한 정신으로) room이 비었다가 같은 이름으로
 *    재생성될 때의 순서는 이 테스트가 다루지 않는다.
 *
 * 6) GA-22의 "user1·user2가 같은 room에서 상호 수신"은 room 이름 문자열이
 *    같다는 것만으로 증명되지 않으므로(서버가 이름은 같게 취급하면서 내부
 *    자료구조는 분리하는 버그도 이론상 가능) 실제 'message' 상호 송수신으로
 *    직접 확인한다(RQ-01/02 기존 계약 재사용, 신규 계약 아님).
 *
 * ── 스펙 노트 (차단 아님 — 후속 조치 권고, 이 세션은 아래 방향으로 진행함) ──
 *
 * (a) docs/adr/0004-global-channel.md 결과 섹션: "room 목록(RQ-13)에 global이
 *     항상 표시된다." 이 문장은 2026-07-17 ADR 승인 시점(GA-21/22/23 신설
 *     이전, 커밋 660cfbb는 2026-07-20)에 쓰였고, 이후 신설된 GA-21의 "then"은
 *     정확히 [room-A]로 global을 배제한다 — 두 문서가 문면상 상충한다. 이
 *     세션은 (1) GA-21의 배열 리터럴이 더 구체적이고 이 RQ의 실제 인수
 *     기준(verify: integration_test)이라는 점, (2) global이 이미 RQ-12/13
 *     양쪽에서 "예외" 취급을 받는 특수 room이라 목록 제외가 그 연장선에서
 *     일관적이라는 점, (3) 이 작업을 위임한 세션(main)이 프롬프트에서 이미
 *     "목록에 global이 없음을 단언해도 좋다"고 명시적으로 승인한 점에 근거해
 *     **global 제외**로 진행했다. 다만 ADR-0004가 명시적으로 개정되지 않은
 *     채 남아 있으므로, RQ-13 병합 전(또는 함께) ADR-0004 결과 섹션을
 *     정정하는 후속 커밋을 권고한다(CLAUDE.md "ADR 모순 구현 금지, 변경은 새
 *     ADR 먼저" 원칙).
 * (b) docs/adr/0004-global-channel.md 결정 3: "'global'(대소문자 무시)은
 *     예약 이름 — 사용자의 room 생성 요청에서 거부한다." RQ-13에 결부돼
 *     있으나 GA-21/22/23 어디에도 이 거부 동작에 대응하는 골든이 없다(이
 *     RQ 신설 커밋 660cfbb에도 없음). 이 파일은 이 거부 동작을 테스트하지
 *     않는다 — 골든 없는 행동을 창작하지 않는다는 원칙, 그리고 이 작업의
 *     명시된 스코프(GA-21/22/23)를 따른 것이다. RQ-13을 "완료"로 종결하기
 *     전에 이 거부 동작에 대응하는 골든 케이스 신설 여부를 확인할 것을
 *     권고한다.
 *
 * 부정 단언은 이 파일에서 사용하지 않는다(모든 GA가 "수신함"을 요구하는
 * 양성 단언이다) — 상한 있는 대기(ADR-0005)만 사용한다.
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

describe('RQ-13 / GA-21: room 생성 시 존재 room 목록이 미참여자를 포함한 전체 접속자에게 방송된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A를 생성(참여)하면 user1과 room 미참여자 user2 모두 존재 room 목록 [room-A]를 수신한다 (RQ-13, GA-21)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user-created room 없음 (user1·user2 접속, 각자 global만 참여).
      // 이 시점엔 존재 room 목록이 비어 있으므로(신설 계약 2-b) 접속 시
      // 별도의 "초기 빈 목록" 이벤트를 보내지 않는다 — 따라서 여기서 그런
      // 이벤트를 소비/대기하지 않는다.

      // when: user1이 room-A를 생성(참여). 트리거(emit) 직전에 관찰자를
      // 동기적으로 등록해야 서버의 동기 처리 중 브로드캐스트를 놓치지 않는다.
      const user1SeesCreation = waitForRoomsEvent(user1);
      const user2SeesCreation = waitForRoomsEvent(user2);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);

      // then: user1(생성자 자신)·user2(미참여자) 모두 [room-A]를 수신한다.
      // Promise.allSettled로 두 수신 대기를 동시에 마무리한다(개별 순차 await
      // 시 앞선 것이 먼저 reject하면 뒤따르는 promise의 거부가 처리되지 않은
      // 채 새어나가는 것을 방지 — 기존 rq-04/rq-15 테스트와 동일 근거).
      const expected: RoomsPayload = { rooms: ['room-A'] };
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
    'user1이 room-A 참여 중일 때 user2가 같은 이름 room-A로 참여를 시도하면 동일 room에 합류(상호 수신)하고, 존재 room 목록은 room-A 1개로 유지된다 (RQ-13, GA-22)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1이 room-A에 참여 중 (존재 room 목록 [room-A]).
      const user1SeesCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedRooms: RoomsPayload = { rooms: ['room-A'] };
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

      // then (목록은 room-A 1개 유지): user2의 join은 이미 존재하는 room-A의
      // 멤버 수만 늘릴 뿐 "존재 room 집합" 자체를 바꾸지 않으므로 새 'rooms'
      // 방송이 반드시 발생한다고 단정할 수 없다(신설 계약 3·4번). 방송을
      // 기다리는 대신, 지금 새로 접속하는 관찰자(checker)가 접속 즉시 받는
      // 현재 목록 스냅샷(신설 계약 2-b, 목록이 비어있지 않으므로 발동)으로
      // "그 순간의 실제 목록"을 직접 확인한다 — room-A가 정확히 1개만
      // 있어야 한다(중복 생성됐다면 ['room-A','room-A'] 같은 값이 되거나,
      // 별도 room이 생겼다면 다른 이름이 섞여 있을 것이다).
      const checker = connectClient(url, cleanupFns);
      const checkerSnapshot = await waitForRoomsEvent(checker);
      expect(checkerSnapshot).toEqual(expectedRooms);
    }
  );
});

describe('RQ-13 / GA-23: room의 마지막 참여자가 떠나면 빈 room은 존재 room 목록에서 제외되고 전체 접속자에게 방송된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-A에 user1만 참여 중일 때 user1이 room-A를 떠나면, user1 자신과 room-A 비참여자 outsider 모두 room-A가 빠진 존재 room 목록을 수신한다 (RQ-13, GA-23)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      // outsider: room-A에 한 번도 참여하지 않은 채 접속만 유지하는 관찰자
      // — GA-23의 "전체 사용자" 요구를 검증하는 대조군(GA-21과 동일 근거).
      const outsider = connectClient(url, cleanupFns);

      // given: room-A에 user1만 참여 (존재 room 목록 [room-A]). 생성 방송
      // 자체를 outsider도 받는지는 GA-21이 이미 검증했으므로 여기서는 given
      // 상태를 만드는 user1의 수신만 확인한다(outsider의 'rooms' 리스너는
      // 아직 등록하지 않으므로 이 생성 이벤트는 outsider 쪽에서 소비되지
      // 않은 채 남는다 — 이후 "when" 단계에서 outsider에 새 리스너를 등록해도
      // 서로 간섭하지 않는다. once 리스너는 등록 시점 이후의 발신만 받는다).
      const user1SeesCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedAfterJoin: RoomsPayload = { rooms: ['room-A'] };
      await expect(user1SeesCreation).resolves.toEqual(expectedAfterJoin);

      // when: user1이 room-A를 떠나 room-A가 빈 상태가 된다(마지막 멤버
      // leave). 트리거(emit) 직전에 두 관찰자를 동기적으로 등록한다.
      const user1SeesEmptied = waitForRoomsEvent(user1);
      const outsiderSeesEmptied = waitForRoomsEvent(outsider);
      const leaveAck = await waitForLeaveAck(user1, { room: 'room-A' });
      expect(leaveAck.ok).toBe(true);

      // then: 전체 접속자(퇴장 당사자 user1·비참여자 outsider 모두)가 room-A
      // 없는 목록([])을 수신한다 — 빈 room은 목록에서 제외된다(메모리 삭제
      // 자체는 RQ-12 영역, 이 테스트는 "목록"의 정확성만 본다).
      const expectedAfterLeave: RoomsPayload = { rooms: [] };
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

describe('RQ-13 (파생, 골든 아님): 여러 room이 동시에 존재할 때 목록 순서는 생성 순서를 따른다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-21/22/23은 room-A 하나만 등장해 순서를 검증할 수 없다.
  // RQ-13 EARS("존재하는 모든 room의 목록")는 동시에 여러 room이 존재할 수
  // 있음을 전제하므로, 목록 순서가 결정적이지 않으면 이 배열을 다루는 어떤
  // 테스트도(그리고 실제 UI도) 안정적으로 검증/렌더링할 수 없다(ADR-0005
  // 테스트 가능성 요건). 파일 상단 신설 계약 5번의 순서 규칙(생성 순서)을
  // 여기서 실제로 핀 고정한다.
  it(
    'user1이 room-A를 먼저 생성하고 user2가 이어서 room-B를 생성하면, 존재 room 목록은 생성 순서 [room-A, room-B]로 방송된다 (RQ-13 파생, 골든 아님)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const user1SeesFirstCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      const expectedAfterFirst: RoomsPayload = { rooms: ['room-A'] };
      await expect(user1SeesFirstCreation).resolves.toEqual(expectedAfterFirst);

      const user1SeesSecondCreation = waitForRoomsEvent(user1);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);
      const expectedAfterSecond: RoomsPayload = { rooms: ['room-A', 'room-B'] };
      await expect(user1SeesSecondCreation).resolves.toEqual(expectedAfterSecond);
    }
  );
});

describe('RQ-13 (파생, 골든 아님): 이미 room이 존재하는 상태에서 새로 접속한 소켓은 별다른 요청 없이 즉시 현재 목록을 수신한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-21/22/23 중 "이미 room이 존재하는 상태에서 새로 접속"을
  // 다루는 케이스가 없다. 그러나 RQ-13 EARS는 "모든 사용자에게 제공"이라고
  // 못박아, 변화 시점에 마침 접속해 있던 사용자만이 아니라 그 이후 접속하는
  // 사용자도 대상에 포함한다 — 신설 계약 2-b(신규 접속자 초기 전달)를
  // 여기서 직접 핀 고정한다. 이 메커니즘은 GA-22 검증(체커 스냅샷)의 전제이기도
  // 하다.
  it(
    'room-A가 이미 존재하는 상태에서 새로 접속한 소켓은 join 없이도 즉시 존재 room 목록 [room-A]를 수신한다 (RQ-13 파생, 골든 아님)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);

      // 위 join으로 room-A가 이미 존재하는 상태가 된 뒤에 새로 접속한다.
      const newcomer = connectClient(url, cleanupFns);
      const initialSnapshot = await waitForRoomsEvent(newcomer);
      const expected: RoomsPayload = { rooms: ['room-A'] };
      expect(initialSnapshot).toEqual(expected);
    }
  );
});
