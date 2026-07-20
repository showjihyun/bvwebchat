import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-01 (specs/requirements.md §1):
 * "사용자가 room에 참여하면, 시스템은 그 사용자를 해당 room의 수신자 목록에
 * 추가해야 한다."
 *
 * GA-05 (evals/golden/track-a-product.jsonl):
 *   given : user1 미참여 상태
 *   when  : user1이 room-A 참여 후 즉시 user2가 room-A에 전송
 *   then  : user1이 수신
 *   verify: integration_test
 *
 * 검증 방식: "참여가 수신자 목록에 반영됐는가"를 직접 조회하는 API는 스펙에
 * 없다 (참여자 목록 조회는 RQ-15 스코프). GA-05가 요구하는 대로, 참여 직후
 * 도착한 메시지를 실제로 수신하는지로 간접 검증한다 — 수신하면 수신자
 * 목록에 등록된 것이고, 수신하지 못하면 등록되지 않은 것이다.
 *
 * user2도 room-A에 join하는 이유: RQ-02(GA-10)는 "미참여자의 room 전송을
 * 서버가 거부해야 한다"고 요구하지만 그건 이 RQ의 스코프가 아니다. user2가
 * room-A 멤버라는 전제를 이 테스트가 스스로 만족시켜, RQ-02의 미결 정책에
 * 이 테스트의 성패가 좌우되지 않게 한다. 이 테스트가 검증하는 것은 오직
 * "user1의 join이 user1을 수신자로 만드는가"이다.
 *
 * ── 서버 계약 (이 테스트가 정의 — 아직 구현 없음, coder의 구현 대상) ──
 *
 * import { createChatServer } from 'src/server/createChatServer'
 *
 *   createChatServer(): { httpServer: http.Server; io: socketio.Server }
 *     - 반환된 httpServer는 아직 listen()되지 않은 상태다. 포트는 테스트가
 *       0(임의 포트)으로 정하고 실제 배정된 포트를 읽어 클라이언트를 붙인다.
 *
 * 클라이언트 → 서버 이벤트:
 *   'join'    payload: { room: string; nickname: string }
 *             ack 콜백: (res: { ok: true } | { ok: false; error: string }) => void
 *             — 해당 소켓을 room의 수신자 목록에 추가한다 (RQ-01 본체).
 *   'message' payload: { room: string; body: string }
 *             — nickname은 재전송하지 않는다. 서버가 join 시 이 소켓에
 *               연결한 nickname을 조회해 사용한다 (클라이언트 자칭 nickname을
 *               매 메시지마다 신뢰하지 않는다).
 *
 * 서버 → 클라이언트 이벤트 (room 멤버 전원에게 브로드캐스트):
 *   'message' payload: ChatMessage = { room, nickname, body } (src/shared/types.ts)
 */
describe('RQ-01 / GA-05: room 참여 직후 도착한 메시지를 수신한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  /** 지정 이벤트가 timeoutMs 내에 오지 않으면 reject한다 — 하드코딩 sleep 대신 상한 명시 (ADR-0005). */
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

  /** join emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시 (ADR-0005). */
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

  it('user1이 room-A에 참여한 직후 user2가 보낸 메시지를 수신한다 (RQ-01, GA-05)', async () => {
    const { httpServer, io } = createChatServer();

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://localhost:${port}`;

    const user1 = ioClient(url, { forceNew: true });
    const user2 = ioClient(url, { forceNew: true });
    cleanupFns.push(() => user1.disconnect());
    cleanupFns.push(() => user2.disconnect());
    cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));

    // given: user1 미참여 상태 → user1이 room-A에 참여
    const joinAck1 = await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' });
    expect(joinAck1.ok).toBe(true);

    // user2도 room-A 멤버여야 전송할 수 있다 (위 주석 참조 — RQ-02 정책과 분리)
    const joinAck2 = await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' });
    expect(joinAck2.ok).toBe(true);

    // when: user1 참여 직후 user2가 room-A에 전송
    const received = waitForEvent<ChatMessage>(user1, 'message');
    user2.emit('message', { room: 'room-A', body: 'hello from user2' });

    // then: user1이 수신한다 (= join이 수신자 목록에 실제로 반영됐다는 증거)
    const message = await received;
    expect(message).toEqual<ChatMessage>({
      room: 'room-A',
      nickname: 'user2',
      body: 'hello from user2',
    });
  });
});
