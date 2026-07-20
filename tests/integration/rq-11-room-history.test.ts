import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-11 (specs/requirements.md §2):
 * "사용자가 room에 입장하면, 시스템은 해당 room의 최근 50개 메시지를 표시해야
 * 한다. 메시지는 인메모리로 보관하며, 서버 재시작 시 소실을 허용한다 (영속 DB
 * 비요구)."
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-11):
 *   GA-08
 *     given: room-A에 메시지 5개 존재 (인메모리)
 *     when : user3이 room-A에 새로 참여
 *     then : 최근 50개 한도 내이므로 5개 전부 히스토리로 표시
 *     verify: integration_test
 *
 * ── ADR-0002 파생 경계 테스트 (골든 아님, team-lead 지시로 추가) ──
 * GA-08은 5개(<50)만 다뤄 "최근 50개"라는 상한 자체를 직접 검증하지 않는다.
 * ADR-0002(메시지 영속성 — room당 최근 50개 링버퍼, 초과 시 오래된 것부터
 * 폐기)의 load-bearing 조건이므로, 51개 이상 존재 시 최근 50개만 재생되고
 * 가장 오래된 메시지가 폐기되는지를 별도 describe 블록으로 검증한다(아래
 * "ADR-0002 링버퍼 파생" 블록 — GA-ID 없음, 이 세션이 ADR로부터 도출).
 *
 * ── 스코프 경계 (질문 아님 — 이 세션의 설계 결정 및 team-lead 지시) ──
 * - 순서 보장(RQ-14)은 이 RQ의 스코프가 아니다. 다만 히스토리 재생은 정의상
 *   자연히 순서대로여야 하므로(순서가 뒤섞이면 "히스토리 표시" 요구 자체가
 *   무의미해진다) 아래 테스트들은 히스토리 배열의 순서를 단언한다 — 이는
 *   RQ-14의 중복 검증이 아니라 RQ-11 "표시" 요구의 전제조건이다.
 * - 안 읽음 개수(RQ-18)는 이 RQ의 스코프가 아니다 — 다루지 않는다.
 * - global room 히스토리 재생 시점: ADR-0004는 global도 같은 ADR-0002
 *   링버퍼를 쓴다고 규정하지만, connect 시 자동 참여(join 이벤트 없이 서버가
 *   직접 socket.join(GLOBAL_ROOM)을 호출하는 기존 RQ-04 구현 — 이 파일 하단
 *   서버 계약 절 참고)에서 히스토리를 언제·어떻게 전달할지는 이 세션이
 *   강제하지 않는다. GA-08은 일반 room만 다루므로 이 경계는 열어 두고
 *   산출물 리포트(_workspace/RQ-11/01_test-writer_red.md)에 남긴다.
 *
 * ── 서버 계약 — 기존 (RQ-01/02/03/04/10에서 이미 구현됨, 변경하지 않음) ──
 * src/server/createChatServer.ts:
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가.
 *   message({room,body}) → socket.data.nickname을 조회해 room 멤버 전원에게
 *     'message'(ChatMessage) 브로드캐스트. 발신 소켓이 그 room의 실제 멤버가
 *     아니면 침묵 거부한다(RQ-02).
 *   leave({room}, ack) → 해당 소켓을 room 수신자 목록에서 제거.
 *   접속 시 모든 소켓은 GLOBAL_ROOM에 자동 참여한다(ADR-0004) — 이 자동
 *   참여는 'join' 이벤트를 거치지 않으므로 아래 신설 계약(join ack 확장)의
 *   대상이 아니다.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다, 아직 미구현, coder의 구현 대상) ──
 *
 * 1) 저장: 서버는 room당 최근 50개까지 보관하는 링버퍼(ADR-0002)를 두고,
 *    handleMessage가 브로드캐스트하는 모든 ChatMessage를 그 room의 버퍼에
 *    추가한다. 50개 초과 시 가장 오래된 것부터 폐기한다. 기존 브로드캐스트
 *    로직(io.to(room).emit) 자체는 변경하지 않고 저장 로직만 추가한다 —
 *    회귀 방지: 이 파일이 실행될 때 기존 rq-01~04/10 스위트가 전부 그대로
 *    통과해야 한다(전체 스위트 실행 시 자동으로 함께 검증됨).
 *
 * 2) 전달 방식 (설계 결정 — 세 후보 중 (a) 채택):
 *    (a) join ack에 history 배열 포함 [채택]
 *    (b) 별도 'history' 이벤트로 배열 전송
 *    (c) 개별 'message' 이벤트로 재생
 *
 *    (a)를 선택한 근거:
 *    - join ack는 이미 이 코드베이스에서 "서버가 이 시점까지 처리를 완료
 *      했다"는 동기화 지점으로 쓰인다(rq-03 leave ack, rq-10 identify ack와
 *      동일 패턴). (b)·(c)는 클라이언트가 "히스토리 재생이 끝나고 라이브
 *      스트림이 시작되는 경계"를 판단할 추가 신호(예: "히스토리 종료" 마커)가
 *      필요해진다. join ack 자체가 이미 그 경계이므로 별도 신호 없이 얻어진다.
 *    - Node.js 이벤트 루프는 단일 스레드다. handleJoin이 socket.join(room) →
 *      링버퍼 스냅샷 읽기 → ack 호출까지 동기적으로(await 없이) 수행하면, 그
 *      사이에 다른 소켓의 'message' 핸들러가 끼어들 수 없다 — 즉 히스토리
 *      스냅샷과 이후 라이브 브로드캐스트 사이에 누락·중복 창이 구조적으로
 *      없다. **이 원자성은 coder가 handleJoin 구현 시 socket.join과 링버퍼
 *      읽기 사이에 await를 두지 않아야 유지된다** — 이 세션은 이 전제를
 *      명시하고, 아래 테스트로 그 결과(연속성)를 관측한다.
 *    - (c)는 배제: 히스토리 항목과 라이브 메시지가 동일 이벤트('message')로
 *      구분 없이 섞이면 클라이언트가 "과거 재생인지 새 메시지인지" 구분할
 *      신호가 없다(추후 RQ-18 안 읽음 카운트가 히스토리 재생을 새 메시지로
 *      오인해 오염될 위험 — 지금 요구는 아니나 (a)를 막을 이유도 없다).
 *
 * 3) shape: 히스토리 항목은 별도 마킹 없이 ChatMessage 그대로(room, nickname,
 *    body)다 — 골든/스펙 어디에도 "히스토리임을 구분해야 한다"는 요구가 없고
 *    (src/shared/types.ts 상단 주석: "추가 필드는 테스트/ADR이 요구할 때
 *    확장한다"), 동일 shape이어야 클라이언트가 히스토리 배열과 라이브
 *    메시지를 같은 렌더링 경로로 이어붙일 수 있다.
 *
 * 4) 계약 shape:
 *    JoinAck = { ok: true; history: ChatMessage[] } | { ok: false; error: string }
 *    - history는 오래된 것 → 최신 순(도착 순서, RQ-14와 일관)으로 정렬된
 *      배열이다.
 *    - ok:false(거부) 시에는 history 필드가 없다 — 참여 자체가 실패했으므로
 *      히스토리도 없다.
 *    - 이 확장은 기존 rq-01/02/03/04/10 테스트 파일에 회귀를 일으키지 않는다
 *      — 각 파일은 자신만의 지역 JoinAck 타입({ok:true}만 접근)을 쓰고
 *      런타임 응답 객체에 필드가 추가돼도 그 타입 검사에 영향이 없다(각
 *      파일이 실제로 쓰는 필드만 좁게 타이핑하는 이 저장소의 기존 관례).
 *
 * 연속성(누락·중복·순서 뒤섞임 없음) 검증 방법: join ack로 history를 받은
 * 직후 250ms 동안 'message' 이벤트가 추가로 오지 않아야 한다(히스토리가
 * message 이벤트로 이중 전달되지 않음을 확인 — assertNoEvent). 그 다음 실제
 * 라이브 메시지를 하나 보내 정상적으로 'message' 이벤트로 수신되는지 확인해
 * "히스토리 → 라이브"로 매끄럽게 이어짐을 증명한다.
 *
 * 부정 단언 공통 원칙(ADR-0005): "수신하지 않는다"는 무한 대기가 아니라 짧은
 * 상한(기본 250ms) 내 이벤트 미도착으로 확인한다 (assertNoEvent 참고).
 */

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

/**
 * 지정 이벤트가 timeoutMs 내에 절대 도착하지 않아야 함을 확인하는 부정 단언.
 * 이벤트가 도착하면 즉시 reject(실패 사유를 담아)하고, timeoutMs 동안 도착하지
 * 않으면 resolve한다 (ADR-0005 — 모든 대기에 상한 명시).
 */
function assertNoEvent(socket: ClientSocket, event: string, timeoutMs = 250): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      reject(new Error(`'${event}' 이벤트가 도착해서는 안 되는데 도착했다: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeoutMs);
    socket.once(event, onEvent);
  });
}

/**
 * 지정 이벤트가 정확히 count개 도착할 때까지 수집한다 — 대량 메시지 전송을
 * 개별 라운드트립 대기 없이 한 번에 확인하기 위한 헬퍼(51개 경계 테스트에서
 * 사용). timeoutMs 내에 count개가 모이지 않으면 reject한다(ADR-0005 상한 명시).
 */
function collectMessages(socket: ClientSocket, count: number, timeoutMs = 5000): Promise<ChatMessage[]> {
  return new Promise((resolve, reject) => {
    const collected: ChatMessage[] = [];
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(
        new Error(
          `'message' 이벤트 ${count}개 중 ${collected.length}개만 ${timeoutMs}ms 내에 도착했다`
        )
      );
    }, timeoutMs);
    function onMessage(payload: ChatMessage): void {
      collected.push(payload);
      if (collected.length === count) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(collected);
      }
    }
    socket.on('message', onMessage);
  });
}

/** RQ-11 신설 계약: join ack에 history 배열이 포함된다 (파일 상단 주석 참고). */
type JoinAck = { ok: true; history: ChatMessage[] } | { ok: false; error: string };

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

describe('RQ-11 / GA-08: room 입장 시 최근 메시지 히스토리를 표시한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-A에 메시지 5개 존재 후 user3이 참여하면 5개 전부를 순서대로 히스토리로 받고, 이후 라이브 메시지도 중복·누락 없이 이어받는다 (RQ-11, GA-08)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns); // room-A 발신자
      const user2 = connectClient(url, cleanupFns); // room-A 기존 멤버 — 브로드캐스트 관찰로 저장을 확정
      const user3 = connectClient(url, cleanupFns); // "user3이 room-A에 새로 참여" (GA-08)

      // given: room-A에 메시지 5개 존재 (인메모리) — user1·user2가 먼저 참여한
      // 상태에서 user1이 5개를 전송하고, 기존 멤버 user2가 각 브로드캐스트를
      // 실제로 수신함으로써 "저장/브로드캐스트가 실제로 일어났다"를 확정한다.
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      const observedByUser2 = collectMessages(user2, 5);
      for (let i = 1; i <= 5; i += 1) {
        user1.emit('message', { room: 'room-A', body: `msg-${i}` });
      }
      const priorMessages = await observedByUser2;
      // sanity: 5개가 전송 순서 그대로 관찰됐다 (이후 history 기대값의 근거)
      expect(priorMessages.map((m) => m.body)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);

      // when: user3이 room-A에 새로 참여
      const joinAck = await waitForJoinAck(user3, { room: 'room-A', nickname: 'user3' });

      // then: 최근 50개 한도 내이므로 5개 전부 히스토리로 표시 (GA-08), 순서는
      // 도착 순서(오래된 것 → 최신)와 일치해야 한다.
      if (joinAck.ok === false) {
        throw new Error(`join 실패: ${joinAck.error}`);
      }
      expect(joinAck.history).toEqual(priorMessages);

      // 연속성 검증 1: history가 join ack로 이미 전달됐으므로, 그 직후
      // 'message' 이벤트로 동일 항목이 다시(이중으로) 오지 않아야 한다 —
      // (a) 방식(join ack 포함)과 (c) 방식(개별 message 재생)이 동시에
      // 구현되는 오작동을 배제한다.
      await expect(assertNoEvent(user3, 'message')).resolves.toBeUndefined();

      // 연속성 검증 2: 히스토리 수신 이후 실제 라이브 메시지를 보내면 정상
      // 'message' 이벤트로, 정확히 한 번, 누락 없이 수신된다 — "히스토리 →
      // 라이브"가 매끄럽게 이어짐을 증명한다.
      const liveReceived = waitForEvent<ChatMessage>(user3, 'message');
      user1.emit('message', { room: 'room-A', body: 'msg-6-live' });
      const liveMessage = await liveReceived;
      expect(liveMessage).toEqual<ChatMessage>({ room: 'room-A', nickname: 'user1', body: 'msg-6-live' });

      // 연속성 검증 3: 라이브 메시지 1건 외에 추가 중복 이벤트가 없어야 한다.
      await expect(assertNoEvent(user3, 'message')).resolves.toBeUndefined();
    }
  );
});

describe(
  'RQ-11 (ADR-0002 링버퍼 파생, 골든 아님): 51개 초과 시 최근 50개만 히스토리로 남고 가장 오래된 메시지는 폐기된다',
  () => {
    const cleanupFns: Array<() => void | Promise<void>> = [];

    afterEach(async () => {
      while (cleanupFns.length > 0) {
        const fn = cleanupFns.pop();
        if (fn) await fn();
      }
    });

    it(
      'room-A에 51개 메시지가 쌓인 뒤 새로 참여한 사용자는 최근 50개(msg-2~msg-51)만 순서대로 받고 가장 오래된 msg-1은 받지 못한다 (ADR-0002 링버퍼)',
      async () => {
        const url = await startServer(cleanupFns);
        const user1 = connectClient(url, cleanupFns); // room-A 발신자
        const user2 = connectClient(url, cleanupFns); // room-A 기존 멤버 — 51개 전부 저장 확정용 관찰자
        const user3 = connectClient(url, cleanupFns); // 51개 적재 후 새로 참여하는 사용자

        // given: room-A에 51개 메시지 존재 (링버퍼 상한 50을 1개 초과)
        expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
        expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

        const observedByUser2 = collectMessages(user2, 51, 10000);
        for (let i = 1; i <= 51; i += 1) {
          user1.emit('message', { room: 'room-A', body: `msg-${i}` });
        }
        const allSent = await observedByUser2;
        // sanity: 51개 전부가 전송 순서 그대로 실제 브로드캐스트(=저장)됐다.
        expect(allSent).toHaveLength(51);
        expect(allSent.map((m) => m.body)).toEqual(Array.from({ length: 51 }, (_, i) => `msg-${i + 1}`));

        // when: user3이 room-A에 새로 참여
        const joinAck = await waitForJoinAck(user3, { room: 'room-A', nickname: 'user3' });

        // then: 최근 50개(msg-2~msg-51)만 순서대로 히스토리에 남고, 가장
        // 오래된 msg-1은 링버퍼에서 폐기되어 히스토리에 없어야 한다.
        if (joinAck.ok === false) {
          throw new Error(`join 실패: ${joinAck.error}`);
        }
        expect(joinAck.history).toHaveLength(50);
        expect(joinAck.history.map((m) => m.body)).toEqual(
          Array.from({ length: 50 }, (_, i) => `msg-${i + 2}`)
        );
        expect(joinAck.history.some((m) => m.body === 'msg-1')).toBe(false);
      },
      10000
    );
  }
);
