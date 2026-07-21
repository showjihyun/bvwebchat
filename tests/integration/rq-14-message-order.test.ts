import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-14 (specs/requirements.md §2):
 * "한 room에서 메시지들이 전송되면, 시스템은 해당 room 참여자 전원에게 서버
 * 도착 순서와 동일한 순서로 전달해야 한다. 일시 단절 후 재접속 시 별도 정밀
 * 복구는 하지 않으며, 재입장 히스토리(RQ-11)로 대체한다."
 *
 * ── 스코프 경계 (질문 아님 — 이 세션의 판정) ──
 * EARS의 두 번째 문장("일시 단절 후 재접속 시 별도 정밀 복구는 하지 않는다")은
 * **비요구**다 — "정밀 복구를 하지 않아도 된다"는 면제 조항이지 구현해야 할
 * 행동이 아니다(재접속 시의 재현은 이미 RQ-11 히스토리 재생으로 대체됐고
 * tests/integration/rq-11-room-history.test.ts가 그 계약을 다룬다). 이 파일은
 * 첫 번째 문장("도착 순서 == 수신 순서")만 검증 대상으로 삼는다. 재접속·단절
 * 시나리오는 창작하지 않는다.
 *
 * ── 이 RQ의 특수성 — ADR-0001과의 관계 ──
 * docs/adr/0001-realtime-transport.md §근거: "단일 서버 이벤트 루프에서 room
 * 내 도착 순서가 자연 보장(RQ-14)." §결과: "순서 보장이 단일 프로세스 전제에
 * 기댐 — 멀티 서버 확장 시 어댑터와 순서 재설계 필요(RQ-16 100명 규모에서는
 * 불필요)."
 * src/server/createChatServer.ts의 handleMessage는 격리 검사 → io.to(room).emit
 * → 링버퍼 저장까지 전부 동기(await 없음)이고, Socket.IO는 단일 연결에서
 * 메시지 순서를 보존한다. 즉 RQ-14의 순서 보장은 새 구현이 아니라 ADR-0001이
 * 이미 채택한 아키텍처의 **부수 효과**다 — RQ-11(tests/integration/
 * rq-11-room-history.test.ts)의 "51개 초과" 파생 테스트가 이미 51개 메시지를
 * 연속 전송해 순서대로 수신됨을 확인했고(status: done, 현재 통과 중) 이는
 * 이 RQ의 순서 보장이 이미 사실상 성립함을 방증한다.
 *
 * 따라서 이 파일의 목적은 "아직 없는 동작을 구현시키는 Red"가 아니라, ADR-0001이
 * 약속한 순서 보장을 **회귀로부터 고정하는 가드**다(RQ-12의 GA-25/27, RQ-13
 * 일부 파생과 같은 성격 — team-lead 사전 판정, docs/progress.md RQ-14 행 참고).
 * 실제 Red/Green 여부는 추측하지 않고 아래 테스트를 실행해 판정한다
 * (_workspace/RQ-14/01_test-writer_red.md 참고).
 *
 * ── 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-14) ──
 *   GA-07
 *     given : user1이 room-A에 연속으로 메시지 3개 전송
 *     when  : room-A 참여자 user2가 수신
 *     then  : 서버 도착 순서와 동일한 순서로 3개 수신 (room 내 순서 보장)
 *     verify: integration_test
 *
 * ── 강화 이유 (파생 테스트, 골든 아님) ──
 * GA-07 원문 그대로(3개, 수신자 1명)만 검증하면 표본이 작아 재정렬 결함을
 * 잡아내는 가드 가치가 낮다(사실상 거의 모든 순서 무관 구현도 우연히 통과할
 * 수 있는 크기). 아래 세 파생 테스트로 강화한다:
 *   1) 단일 발신자·다수 메시지(40개)·단일 수신자 — 표본 확대로 재정렬 결함
 *      검출력을 높인다.
 *   2) 단일 발신자·다수 메시지(30개)·다중 수신자(user2, user3) — EARS의
 *      "참여자 전원"을 GA-07(수신자 1명)이 다루지 못하므로 보완한다.
 *   3) 다중 발신자 인터리브·다중 수신자 — 서로 다른 발신자 간 절대 도착
 *      순서는 네트워크 타이밍에 좌우돼 비결정적일 수 있으므로 절대 순서를
 *      예측해 단언하지 않는다. 대신 ADR-0001이 실제로 보장하는 바 — "room
 *      참여자 전원에게 서버 도착 순서와 동일한 순서로 전달"— 를 "모든
 *      수신자가 서로 동일한 순서를 관찰하는가"(수신자 간 일관성)로
 *      검증한다. 부가로 각 발신자 자신의 메시지 상대 순서 보존도 확인한다.
 *
 * 순번은 src/shared/types.ts의 ChatMessage에 전용 필드가 없으므로(주석: "추가
 * 필드는 테스트/ADR이 요구할 때 확장한다") 기존 `body: string` 안에 순번을
 * 인코딩해 배열 비교(toEqual)로 엄밀히 단언한다 — 스키마 확장을 요구하지
 * 않는다.
 *
 * ── 기존 서버 계약 (이미 구현·머지됨, 변경하지 않음) ──
 * src/server/createChatServer.ts:
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가(RQ-01).
 *   message({room,body}) → socket.data.nickname을 조회해 room 멤버 전원에게
 *     'message'(ChatMessage) 브로드캐스트(RQ-02). 발신 소켓이 그 room의 실제
 *     멤버가 아니면 침묵 거부한다.
 * 이 파일은 신규 서버 계약을 도입하지 않는다 — 기존 'message' 브로드캐스트의
 * 순서 속성만 관찰한다.
 *
 * 부정 단언은 이 파일에서 사용하지 않는다(모든 단언이 "동일 순서로 수신함"을
 * 요구하는 양성 단언) — 상한 있는 대기(ADR-0005)만 사용한다.
 */

/**
 * 지정 이벤트가 정확히 count개 도착할 때까지 수집한다 — 대량 메시지 전송을
 * 개별 라운드트립 대기 없이 한 번에 확인하기 위한 헬퍼(rq-11-room-history.test.ts의
 * collectMessages와 동일 패턴, 이 파일 전용 복사본 — 저장소 기존 관례: 테스트
 * 파일마다 헬퍼를 독립적으로 둔다). timeoutMs 내에 count개가 모이지 않으면
 * reject한다(ADR-0005 상한 명시).
 */
function collectMessages(socket: ClientSocket, count: number, timeoutMs = 5000): Promise<ChatMessage[]> {
  return new Promise((resolve, reject) => {
    const collected: ChatMessage[] = [];
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`'message' 이벤트 ${count}개 중 ${collected.length}개만 ${timeoutMs}ms 내에 도착했다`));
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

/** RQ-14 테스트가 실제로 쓰는 필드만 좁게 타이핑(저장소 기존 관례 — rq-11/13 참고). */
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

describe('RQ-14 / GA-07: room 내 메시지가 서버 도착 순서와 동일한 순서로 참여자에게 전달된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A에 연속으로 메시지 3개를 전송하면 참여자 user2가 서버 도착 순서와 동일한 순서로 3개를 수신한다 (RQ-14, GA-07)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1과 user2 모두 room-A에 참여 중.
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // when: user1이 room-A에 연속으로 메시지 3개 전송 (라운드트립 대기 없이
      // 연속 emit — 수집 리스너는 트리거 직전에 동기 등록한다).
      const sentBodies = ['msg-1', 'msg-2', 'msg-3'];
      const received = collectMessages(user2, 3);
      for (const body of sentBodies) {
        user1.emit('message', { room: 'room-A', body });
      }

      // then: 서버 도착 순서와 동일한 순서로 3개 수신 (room 내 순서 보장, GA-07).
      const messages = await received;
      expect(messages.map((m) => m.body)).toEqual(sentBodies);
    }
  );
});

describe('RQ-14 (파생, 골든 아님): 단일 발신자가 다수 메시지를 연속 전송해도 순서가 뒤섞이지 않는다 (강한 순서 가드)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-07은 3개만 다뤄 재정렬 결함을 잡기엔 표본이 작다(적은
  // 수는 순서를 흔드는 구현이라도 우연히 통과할 여지가 크다). 표본을 40개로
  // 늘려 순서 배열 전체를 엄밀히(toEqual) 비교해 가드 가치를 높인다.
  it(
    'user1이 room-A에 40개 메시지를 연속 전송하면 참여자 user2가 정확히 동일한 순서로 전부 수신한다 (RQ-14 파생, 강한 가드)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      const TOTAL = 40;
      const sentBodies = Array.from({ length: TOTAL }, (_, i) => `seq-${String(i).padStart(3, '0')}`);
      const received = collectMessages(user2, TOTAL, 8000);
      for (const body of sentBodies) {
        user1.emit('message', { room: 'room-A', body });
      }

      const messages = await received;
      expect(messages).toHaveLength(TOTAL);
      expect(messages.map((m) => m.body)).toEqual(sentBodies);
    },
    10000
  );
});

describe('RQ-14 (파생, 골든 아님): 다중 수신자 전원이 동일한 순서로 수신한다 (room 참여자 "전원" 보장)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-07은 수신자를 user2 한 명만 다뤄 EARS 문구("해당 room
  // 참여자 전원에게 ... 동일한 순서로 전달")의 "전원" 부분을 검증하지
  // 못한다. 두 번째 수신자(user3)를 추가해 두 수신자 모두 전송 순서와
  // 일치하는 동일한 순서로 수신하는지 확인한다.
  it(
    'user1이 room-A에 30개 메시지를 연속 전송하면 참여자 user2·user3 모두 전송 순서와 일치하는 동일한 순서로 전부 수신한다 (RQ-14 파생, 강한 가드)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const user3 = connectClient(url, cleanupFns);

      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);
      expect((await waitForJoinAck(user3, { room: 'room-A', nickname: 'user3' })).ok).toBe(true);

      const TOTAL = 30;
      const sentBodies = Array.from({ length: TOTAL }, (_, i) => `multi-${String(i).padStart(3, '0')}`);
      const received2 = collectMessages(user2, TOTAL, 8000);
      const received3 = collectMessages(user3, TOTAL, 8000);
      for (const body of sentBodies) {
        user1.emit('message', { room: 'room-A', body });
      }

      const [messages2, messages3] = await Promise.all([received2, received3]);
      expect(messages2.map((m) => m.body)).toEqual(sentBodies);
      expect(messages3.map((m) => m.body)).toEqual(sentBodies);
      // 두 수신자가 관찰한 배열 자체가 완전히 동일해야 한다(내용+순서 모두).
      expect(messages2).toEqual(messages3);
    },
    10000
  );
});

describe('RQ-14 (파생, 골든 아님): 다중 발신자가 인터리브 전송해도 모든 수신자가 서로 동일한 순서를 관찰한다 (수신자 간 일관성)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-07은 단일 발신자만 다뤄 "여러 발신자의 메시지가 뒤섞일
  // 때"의 순서 보장을 검증하지 못한다. 서로 다른 발신자 간의 절대 도착
  // 순서는 네트워크 타이밍에 좌우돼 비결정적일 수 있으므로(반면 서버가
  // 실제로 처리한 순서 자체는 그 실행에서 하나로 고정되고, 그 고정된 순서를
  // 모든 수신자가 각자의 연결로 그대로 전달받아야 한다는 것이 ADR-0001이
  // 실제로 보장하는 바다) 이 테스트는 절대 순서를 예측해 단언하지 않는다.
  // 대신 "모든 수신자가 서로 동일한 순서를 관찰하는가"(수신자 간 일관성 —
  // 불일치가 있다면 그 자체가 순서 보장 위반이다)로 검증한다. 부가로 각
  // 발신자 자신의 메시지 상대 순서가 인터리브 중에도 보존되는지 확인한다
  // (더 약한 성질이지만 회귀 조기 발견에 도움).
  it(
    'user1·user4가 room-A에 각 20개씩 메시지를 인터리브 전송해도, 참여자 user2·user3은 서로 완전히 동일한 순서로 40개를 수신하고 발신자별 상대 순서도 보존된다 (RQ-14 파생, 강한 가드)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user4 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const user3 = connectClient(url, cleanupFns);

      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user4, { room: 'room-A', nickname: 'user4' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);
      expect((await waitForJoinAck(user3, { room: 'room-A', nickname: 'user3' })).ok).toBe(true);

      const PER_SENDER = 20;
      const TOTAL = PER_SENDER * 2;
      const sender1Bodies = Array.from({ length: PER_SENDER }, (_, i) => `s1-${String(i).padStart(3, '0')}`);
      const sender2Bodies = Array.from({ length: PER_SENDER }, (_, i) => `s2-${String(i).padStart(3, '0')}`);

      const received2 = collectMessages(user2, TOTAL, 8000);
      const received3 = collectMessages(user3, TOTAL, 8000);

      // 인터리브 발신: 두 발신자가 번갈아 하나씩 emit — 서버 도착 순서는
      // 네트워크 타이밍에 좌우되므로 이 발신 순서 그대로 도착한다고
      // 단정하지 않는다(아래 then의 검증 방식 참고).
      for (let i = 0; i < PER_SENDER; i += 1) {
        user1.emit('message', { room: 'room-A', body: sender1Bodies[i] });
        user4.emit('message', { room: 'room-A', body: sender2Bodies[i] });
      }

      const [messages2, messages3] = await Promise.all([received2, received3]);

      // then (핵심 불변 — ADR-0001이 실제로 보장하는 바): 두 수신자는 서버가
      // 실제로 처리한 하나의 순서를 그대로 각자 관찰해야 하므로, 서로
      // 완전히 동일한 배열을 관찰해야 한다.
      expect(messages2).toEqual(messages3);

      // then (누락·중복 없음): 40개 전부, 두 발신자의 바디가 모두 정확히
      // 한 번씩 존재해야 한다(순서 무관 비교).
      expect(messages2).toHaveLength(TOTAL);
      expect(messages2.map((m) => m.body).slice().sort()).toEqual([...sender1Bodies, ...sender2Bodies].sort());

      // then (발신자별 상대 순서 보존 — 부가 가드): 인터리브 중에도 각
      // 발신자 자신의 메시지 상대 순서는 흐트러지지 않아야 한다.
      const user1Subsequence = messages2.filter((m) => m.nickname === 'user1').map((m) => m.body);
      const user4Subsequence = messages2.filter((m) => m.nickname === 'user4').map((m) => m.body);
      expect(user1Subsequence).toEqual(sender1Bodies);
      expect(user4Subsequence).toEqual(sender2Bodies);
    },
    10000
  );
});
