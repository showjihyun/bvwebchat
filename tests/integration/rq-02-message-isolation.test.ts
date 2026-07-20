import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-02 (specs/requirements.md §1):
 * "사용자가 room에 메시지를 보내면, 시스템은 해당 room 참여자 전원에게만 그
 * 메시지를 전달해야 한다. (다른 room·비참여자에게 절대 노출 금지)"
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-02):
 *   GA-01, GA-02, GA-06, GA-10 (각 describe 블록 상단에 given/when/then 재기재)
 *
 * 서버 계약 (RQ-01에서 이미 구현된 기존 모듈 — src/server/createChatServer.ts.
 * 이 RQ는 그 모듈을 새로 만들지 않는다. 상세 계약은
 * tests/integration/rq-01-room-join.test.ts 파일 상단 주석 참고):
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가.
 *   message({room,body}) → 서버가 room 멤버 전원에게 'message'(ChatMessage) 브로드캐스트.
 *   message에는 ack가 없다(fire-and-forget) — "서버가 거부한다"(GA-10)를 직접
 *   관측할 API가 없으므로, 이 파일은 "미참여 room 멤버가 실제로 수신하지
 *   않는다"로 거부를 간접 관측한다 (아래 GA-10 블록 참고).
 *
 * 부정 단언 공통 원칙 (ADR-0005): "수신하지 않는다"는 무한 대기가 아니라
 * 짧은 상한(기본 250ms) 내 이벤트 미도착으로 확인한다 (assertNoEvent 참고).
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
 * 않으면 resolve한다. 무한 대기 대신 짧은 상한(기본 250ms)으로 "room 격리/거부"를
 * 관측한다 (ADR-0005 — 모든 대기에 상한 명시).
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

describe('RQ-02 / GA-01: room 참여자 전원 수신, 다른 room 참여자는 절대 미수신', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A에 전송하면 room-A의 user2는 수신하고 room-B의 user3은 수신하지 않는다 (RQ-02, GA-01)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const user3 = connectClient(url, cleanupFns);

      // given: user1·user2는 room-A, user3는 room-B에 참여
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);
      expect((await waitForJoinAck(user3, { room: 'room-B', nickname: 'user3' })).ok).toBe(true);

      // when: user1이 room-A에 'hello' 전송
      const receivedByUser2 = waitForEvent<ChatMessage>(user2, 'message');
      const notReceivedByUser3 = assertNoEvent(user3, 'message');
      user1.emit('message', { room: 'room-A', body: 'hello' });

      // then: user2는 수신, user3은 절대 수신하지 않음
      const expectedMessage: ChatMessage = { room: 'room-A', nickname: 'user1', body: 'hello' };
      await expect(receivedByUser2).resolves.toEqual(expectedMessage);
      await expect(notReceivedByUser3).resolves.toBeUndefined();
    }
  );
});

describe('RQ-02 / GA-02: 어떤 room에도 참여하지 않은 사용자는 수신하지 않는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A에 전송해도 어떤 room에도 참여하지 않은 user2는 수신하지 않는다 (RQ-02, GA-02)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1은 room-A 참여, user2는 어떤 room에도 미참여 (join 호출 자체를 하지 않음)
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);

      // when: user1이 room-A에 메시지 전송
      // (user1 자신도 room-A 멤버이므로 io.to(room-A)는 발신자에게도 echo된다 —
      //  이를 양성 대조로 함께 확인해 "user2 미수신"이 전송 자체가 안 됐기 때문에
      //  우연히 성립하는 무의미한 통과가 아님을 보장한다.)
      const echoToSender = waitForEvent<ChatMessage>(user1, 'message');
      const notReceivedByUser2 = assertNoEvent(user2, 'message');
      user1.emit('message', { room: 'room-A', body: 'hello' });

      // then: user2는 수신하지 않음
      const expectedEcho: ChatMessage = { room: 'room-A', nickname: 'user1', body: 'hello' };
      await expect(echoToSender).resolves.toEqual(expectedEcho);
      await expect(notReceivedByUser2).resolves.toBeUndefined();
    }
  );
});

describe('RQ-02 / GA-06: 동일 사용자가 두 room에 동시 참여해도 스트림이 섞이지 않는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-A에만 메시지가 발생하면 두 room(A·B)에 동시 참여한 user1의 스트림에 room-B로 잘못 태그되거나 중복된 이벤트가 섞이지 않는다 (RQ-02, GA-06)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns); // room-A·room-B 동시 참여
      const user2 = connectClient(url, cleanupFns); // room-A 발신자

      // given: 동일 사용자(user1)가 두 room(A·B)에 동시 참여
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user1, { room: 'room-B', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // when: room-A에만 메시지 발생
      const received = waitForEvent<ChatMessage>(user1, 'message');
      user2.emit('message', { room: 'room-A', body: 'only in room-A' });
      const message = await received;

      // then: 도착한 메시지는 room-A로 정확히 태그되어야 한다 (room-B로 오태그되어
      // "room-B 화면/스트림"에 나타날 수 없다)
      expect(message).toEqual<ChatMessage>({ room: 'room-A', nickname: 'user2', body: 'only in room-A' });

      // then: room-A 메시지 1건 외에 추가로(중복·room-B 오태그) 도착하는 이벤트가
      // 없어야 한다 — room-B 스트림에 섞여 나타나는 오작동을 함께 배제한다
      await expect(assertNoEvent(user1, 'message')).resolves.toBeUndefined();
    }
  );
});

describe('RQ-02 / GA-10: 서버가 미참여 room 전송을 거부한다 (room 격리는 서버가 강제)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    '미참여 room-A로 직접 전송을 시도해도 room-A 멤버는 수신하지 않는다 — 서버가 거부한다 (RQ-02, GA-10)',
    async () => {
      const url = await startServer(cleanupFns);
      const victim = connectClient(url, cleanupFns); // room-A 정상 참여자
      const attacker = connectClient(url, cleanupFns); // room-A 미참여, room-B에만 참여

      // given: 악의적 클라이언트(attacker)는 room-A에 참여하지 않았다 (room-B에만 참여한
      // 상태에서, UI 경로를 거치지 않고 서버 'message' API를 직접 호출해 room-A로
      // 전송을 시도한다 — "서버 API 직접 호출"을 모사)
      expect((await waitForJoinAck(victim, { room: 'room-A', nickname: 'victim' })).ok).toBe(true);
      expect((await waitForJoinAck(attacker, { room: 'room-B', nickname: 'attacker' })).ok).toBe(true);

      // when: attacker가 미참여 room-A로 직접 전송 요청
      const shouldNotArrive = assertNoEvent(victim, 'message');
      attacker.emit('message', { room: 'room-A', body: 'injected by attacker' });

      // then: 서버가 거부 — room-A의 정상 멤버(victim)는 수신하지 않는다.
      // (관측 방식: message에는 ack가 없어 거부를 직접 응답으로 확인할 수 없다.
      //  대신 "미참여 발신자가 보낸 메시지가 room-A 멤버에게 전달되지 않는다"로
      //  간접 관측한다 — 전달되면 서버가 room 멤버십을 검증하지 않고 브로드캐스트한
      //  것이므로 거부에 실패한 것이다.)
      await expect(shouldNotArrive).resolves.toBeUndefined();
    }
  );
});
