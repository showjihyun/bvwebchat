import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { RoomName } from '../../src/shared/types';

/**
 * RQ-15 (specs/requirements.md §2):
 * "시스템은 각 room의 현재 참여자 목록을 표시해야 한다."
 *
 * 비범위 (specs/requirements.md §3, RQ-15 인터뷰 결정 — 이 파일은 다루지
 * 않는다): 온라인/오프라인 표시, 타이핑 표시. "참여자 목록" = room 멤버십
 * (누가 join했는가)이지 온라인 상태 추적이 아니다.
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-15):
 *   GA-19
 *     given : user1이 room-A에 참여 중 (닉네임 alice)
 *     when  : user2(닉네임 bob)가 room-A에 참여
 *     then  : user1·user2 모두 room-A 참여자 목록을 [alice, bob]로 수신
 *             (참여자 변경 시 room 멤버에게 방송)
 *     verify: integration_test
 *   GA-20
 *     given : user1(alice)·user2(bob)가 room-A에 참여, 참여자 목록 [alice, bob]
 *     when  : user2가 room-A에서 퇴장(leave) 또는 연결 종료(disconnect)
 *     then  : user1이 room-A 참여자 목록 [alice]를 수신
 *             (RQ-02 격리: 참여자 목록은 해당 room 멤버에게만)
 *     verify: integration_test
 *   → GA-20은 "leave 또는 disconnect" 두 경로를 모두 요구한다. 아래
 *     describe 블록에 두 개의 it()(leave 경로 / disconnect 경로)로 나누어
 *     둘 다 검증한다 — 둘 다 같은 GA-20에 매핑된다.
 *
 * ── RQ-18 정합 (2026-07-21, team-lead 지시) — disconnect 경로만 변경 ──
 * ADR-0003 결정5(RQ-18 스코프)는 "연결 종료 시 즉시 퇴장 처리하지 않고 30초
 * 유예를 둔다"를 세션 유무와 무관하게 모든 socket disconnect에 적용한다.
 * 이 파일의 disconnect 경로 테스트는 원래 disconnect 직후 즉시 'participants'
 * 갱신을 기대했으나, 이는 결정5와 충돌한다. **단언(참여자 목록이 결국
 * [alice]로 갱신된다)은 그대로 두고, 타이밍만 "즉시" → "유예(30초) 경과
 * 후"로 교정**했다(vi.useFakeTimers + vi.advanceTimersByTimeAsync, ADR-0005
 * 결정4). leave 경로 테스트(위 GA-20 첫 번째 it())는 leave가 유예 대상이
 * 아니므로(유예는 연결 종료에만 적용) 변경하지 않았다. 상세는
 * _workspace/RQ-18/01_test-writer_red.md 참고.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다. 아직 미구현, coder의 구현 대상) ──
 *
 * 이벤트: 서버→클라이언트 'participants' 브로드캐스트.
 *   payload: { room: RoomName; participants: string[] }
 *
 *   - participants는 표시 이름(닉네임) 문자열 배열이다 — join 시 그 소켓에
 *     연결된 socket.data.nickname(RQ-10)을 사용한다.
 *   - 순서 규칙 (이 세션의 설계 결정 — 결정적이어야 테스트 가능하므로 고정):
 *     해당 room에 **먼저 join한 사람이 배열 앞쪽**에 온다(참여 순, 오름차순).
 *     GA-19 예시 [alice, bob]이 이 규칙과 일치한다(alice가 먼저 참여).
 *     (참고: 퇴장 후 재참여 시 순서가 어떻게 되는지는 골든이 다루지 않으므로
 *     이 테스트도 강제하지 않는다.)
 *   - 발신 대상: 그 순간 해당 room의 멤버 전원(io.to(room).emit 패턴 —
 *     기존 handleMessage와 동일 계약) — room 밖의 사용자에게는 전달되지
 *     않는다(RQ-02 격리, GA-20 "then"에 명시). 새로 참여한 소켓 자신도
 *     io.to(room).emit 시점에는 이미 그 room의 멤버이므로 자연히 수신
 *     대상에 포함된다 — GA-19가 "user1·user2 모두 수신"을 요구하는 근거.
 *   - 트리거: 해당 room의 멤버십이 바뀌는 시점(join, leave, disconnect).
 *   - join ack 자체는 확장하지 않는다(RQ-11의 history와 다른 설계 결정 —
 *     참여자 목록은 "그 순간 room 멤버 전원"에게 방송돼야 하고 위 문단처럼
 *     신규 참여자도 자연히 그 방송을 수신하므로 별도로 join ack에 담을
 *     필요가 없다. 단순성 우선/YAGNI).
 *
 *   disconnect 경로 구현 힌트(강제 아님 — 검증은 관찰 결과로만 한다):
 *   Socket.IO의 'disconnect' 이벤트 시점에는 소켓이 이미 모든 room에서
 *   제거된 뒤이므로, 이 소켓이 있던 room 목록을 알려면 'disconnecting'
 *   이벤트(room 제거 직전)에서 socket.rooms를 스냅샷하거나 서버 자체
 *   멤버십 추적 구조가 필요할 수 있다 — 어떤 방식을 쓰든 이 테스트는
 *   관찰 가능한 결과(남은 참여자에게 갱신된 목록이 도착하는지)만 검증한다.
 *
 *   무관한 room(예: 접속 시 global 자동 참여, ADR-0004)에 대해 구현이
 *   'participants'를 방송하든 말든 이 테스트는 규정하지 않는다 — 아래
 *   waitForParticipantsEvent/assertNoParticipantsEventForRoom가 payload.room
 *   필드로 걸러내므로 room-A 외 이벤트 존재 여부와 무관하게 안정적으로
 *   동작한다.
 *
 * 부정 단언 공통 원칙(ADR-0005): "수신하지 않는다"는 무한 대기가 아니라
 * 짧은 상한(기본 250ms) 내 이벤트 미도착으로 확인한다.
 */

/** RQ-15 신설 계약 payload — 파일 상단 주석 참고. */
interface ParticipantsPayload {
  room: RoomName;
  participants: string[];
}

/**
 * 지정 room에 대한 'participants' 이벤트만 걸러 대기한다 — 다른 room(예:
 * global 자동 참여로 인한 브로드캐스트가 구현에 존재하든 말든)의
 * 'participants' 이벤트는 무시하고 계속 대기한다. timeoutMs 내에 해당 room의
 * 이벤트가 오지 않으면 reject한다(ADR-0005 — 모든 대기에 상한 명시).
 */
function waitForParticipantsEvent(
  socket: ClientSocket,
  room: RoomName,
  timeoutMs = 2000
): Promise<ParticipantsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('participants', onParticipants);
      reject(new Error(`'participants' 이벤트(room=${room})가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    function onParticipants(payload: ParticipantsPayload): void {
      if (payload.room !== room) return; // 무관한 room의 이벤트는 무시하고 계속 대기
      clearTimeout(timer);
      socket.off('participants', onParticipants);
      resolve(payload);
    }
    socket.on('participants', onParticipants);
  });
}

/**
 * 지정 room에 대한 'participants' 이벤트가 timeoutMs 내에 절대 도착하지
 * 않아야 함을 확인하는 부정 단언(RQ-02 격리 검증용, GA-20 "then" 괄호 —
 * "참여자 목록은 해당 room 멤버에게만"). 다른 room의 'participants' 이벤트는
 * 무시한다 — room 밖 사용자가 "이 room"의 참여자 변경을 전혀 모른다는 것만
 * 증명하면 되기 때문이다.
 */
function assertNoParticipantsEventForRoom(
  socket: ClientSocket,
  room: RoomName,
  timeoutMs = 250
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('participants', onParticipants);
      resolve();
    }, timeoutMs);
    function onParticipants(payload: ParticipantsPayload): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('participants', onParticipants);
      reject(
        new Error(`'participants' 이벤트(room=${room})가 도착해서는 안 되는데 도착했다: ${JSON.stringify(payload)}`)
      );
    }
    socket.on('participants', onParticipants);
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

/**
 * startServer와 동일하지만 io도 함께 반환한다 — RQ-18 정합(위 파일 상단
 * 주석 참고): disconnect 경로 테스트가 서버 측 소켓의 실제 'disconnect'
 * 이벤트를 직접 관찰해 fake timer 진행 시점을 동기화해야 하기 때문
 * (rq-12 GA-27의 io 직접 조회 패턴과 동일 근거).
 */
async function startServerWithIo(
  cleanupFns: Array<() => void | Promise<void>>
): Promise<{ url: string; io: ReturnType<typeof createChatServer>['io'] }> {
  const { httpServer, io } = createChatServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
  return { url: `http://localhost:${port}`, io };
}

/** 연결된 클라이언트 소켓의 id를 안전하게 읽는다(연결 전이면 에러). */
function requireSocketId(socket: ClientSocket): string {
  if (!socket.id) {
    throw new Error('클라이언트 소켓이 아직 연결되지 않아 id가 없다');
  }
  return socket.id;
}

/**
 * 서버 측 소켓(clientSocketId와 동일 id)이 실제로 'disconnect'를 발생시킬
 * 때까지 기다린다. 유예(30초) fake timer를 진행시키기 전에, 서버가 이
 * disconnect를 인지해 유예 타이머를 실제로 스케줄한 시점과 동기화하기 위한
 * 헬퍼다(RQ-18 rq-18-unread.test.ts와 동일 헬퍼).
 */
function waitForServerSocketDisconnect(
  io: ReturnType<typeof createChatServer>['io'],
  clientSocketId: string,
  timeoutMs = 2000
): Promise<void> {
  const serverSocket = io.sockets.sockets.get(clientSocketId);
  if (!serverSocket) {
    return Promise.reject(new Error(`서버 측 소켓(id=${clientSocketId})을 찾을 수 없다`));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`서버가 소켓(id=${clientSocketId})의 disconnect를 ${timeoutMs}ms 내에 인지하지 못했다`));
    }, timeoutMs);
    serverSocket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** ADR-0003 결정5: 퇴장 유예 30초 — 경계값 해석은 파일 상단 "RQ-18 정합" 주석 참고. */
const GRACE_PERIOD_MS = 30_000;

describe('RQ-15 / GA-19: room에 새 참여자가 들어오면 기존·신규 참여자 모두 갱신된 참여자 목록을 받는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1(alice)이 room-A 참여 중일 때 user2(bob)가 참여하면, user1·user2 모두 room-A 참여자 목록 [alice, bob]을 수신한다 (RQ-15, GA-19)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const outsider = connectClient(url, cleanupFns); // room-A 비참여자 — RQ-02 격리 대조군

      // given: user1(alice)이 room-A에 참여 중
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);

      // when: user2(bob)가 room-A에 참여. 트리거(emit) 직전에 관찰자를
      // 등록해야 서버가 동기 처리 중 보내는 브로드캐스트를 놓치지 않는다.
      const user1Sees = waitForParticipantsEvent(user1, 'room-A');
      const user2Sees = waitForParticipantsEvent(user2, 'room-A');
      const outsiderNeverSeesRoomA = assertNoParticipantsEventForRoom(outsider, 'room-A');
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);

      // then: user1·user2 모두 [alice, bob] 수신 (참여 순서 — alice가 먼저 참여).
      // Promise.allSettled로 두 수신 대기를 동시에 마무리한다 (rq-04 테스트와
      // 동일 근거): 개별 await 순차 처리 시 앞선 것이 먼저 reject하면 뒤따르는
      // promise의 거부가 처리되지 않은 채 새어나가 "Unhandled Rejection" 잡음을
      // 일으킨다.
      const expected: ParticipantsPayload = { room: 'room-A', participants: ['alice', 'bob'] };
      const [user1Result, user2Result] = await Promise.allSettled([user1Sees, user2Sees]);

      function expectReceived(result: PromiseSettledResult<ParticipantsPayload>, who: string): void {
        if (result.status === 'rejected') {
          throw new Error(`${who} 수신 실패: ${String(result.reason)}`);
        }
        expect(result.value, who).toEqual(expected);
      }
      expectReceived(user1Result, 'user1(alice, 기존 참여자)');
      expectReceived(user2Result, 'user2(bob, 신규 참여자)');

      // RQ-02 격리: room-A 비참여자는 이 참여자 변경을 전혀 알 수 없다.
      await expect(outsiderNeverSeesRoomA).resolves.toBeUndefined();
    }
  );
});

describe('RQ-15 / GA-20: 참여자가 room을 떠나면(leave) 또는 연결이 끊기면(disconnect) 남은 참여자가 갱신된 목록을 받는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1(alice)·user2(bob)가 room-A 참여 후 user2가 leave하면, user1은 room-A 참여자 목록 [alice]를 수신하고 room-A 비참여자는 이를 알 수 없다 (RQ-15, GA-20 leave 경로)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const outsider = connectClient(url, cleanupFns);

      // given: user1(alice)·user2(bob)가 room-A에 참여, 참여자 목록 [alice, bob]
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
      const bothJoinedBroadcast = waitForParticipantsEvent(user1, 'room-A');
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);
      const expectedBothJoined: ParticipantsPayload = { room: 'room-A', participants: ['alice', 'bob'] };
      await expect(bothJoinedBroadcast).resolves.toEqual(expectedBothJoined);

      // when: user2가 room-A에서 leave. 트리거(emit) 직전에 관찰자를 등록한다.
      const user1SeesAfterLeave = waitForParticipantsEvent(user1, 'room-A');
      const outsiderNeverSeesRoomA = assertNoParticipantsEventForRoom(outsider, 'room-A');
      const leaveAck = await waitForLeaveAck(user2, { room: 'room-A' });
      expect(leaveAck.ok).toBe(true);

      // then: user1이 [alice]를 수신한다.
      const expectedAfterLeave: ParticipantsPayload = { room: 'room-A', participants: ['alice'] };
      await expect(user1SeesAfterLeave).resolves.toEqual(expectedAfterLeave);

      // RQ-02 격리: room-A 비참여자는 이 참여자 변경을 전혀 알 수 없다.
      await expect(outsiderNeverSeesRoomA).resolves.toBeUndefined();
    }
  );

  it(
    'user1(alice)·user2(bob)가 room-A 참여 후 user2의 연결이 끊기면(disconnect), 퇴장 유예(30초, ADR-0003 결정5) 경과 후 user1은 room-A 참여자 목록 [alice]를 수신하고 room-A 비참여자는 이를 알 수 없다 (RQ-15, GA-20 disconnect 경로 — RQ-18 정합, 파일 상단 주석 참고)',
    async () => {
      const { url, io } = await startServerWithIo(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const outsider = connectClient(url, cleanupFns);

      // given: user1(alice)·user2(bob)가 room-A에 참여, 참여자 목록 [alice, bob]
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
      const bothJoinedBroadcast = waitForParticipantsEvent(user1, 'room-A');
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);
      const expectedBothJoined: ParticipantsPayload = { room: 'room-A', participants: ['alice', 'bob'] };
      await expect(bothJoinedBroadcast).resolves.toEqual(expectedBothJoined);

      // when: user2의 연결이 강제 종료된다 (leave 이벤트 없이 소켓 자체가 끊김).
      // 트리거(disconnect) 직전에 관찰자를 등록한다. user1SeesAfterDisconnect의
      // 타임아웃(35000ms)은 아래에서 fake timer로 30초+α를 진행시키는 동안
      // 자체 타임아웃이 먼저 발동해 거짓 실패하지 않도록 유예보다 넉넉히 크게
      // 잡는다.
      const user1SeesAfterDisconnect = waitForParticipantsEvent(user1, 'room-A', 35000);
      // "즉시 처리되지 않는다"를 직접 확인하는 부정 단언 — 이게 없으면 유예를
      // 전혀 구현하지 않아도(기존처럼 즉시 처리해도) 이 테스트가 우연히
      // 통과해버린다(회귀를 못 잡는 무의미한 Red/Green이 된다).
      const noImmediateUpdateForUser1 = assertNoParticipantsEventForRoom(user1, 'room-A', 1000);
      const outsiderNeverSeesRoomA = assertNoParticipantsEventForRoom(outsider, 'room-A', 1000);
      // Red 상태에서는 위 두 부정 단언이 (아래에서 실제로 await하기 전에) 이미
      // reject할 수 있다 — Node의 unhandledRejection 경고를 막기 위해 즉시
      // no-op catch를 붙여둔다(원본 promise 참조는 그대로 두어 아래에서 실제
      // 결과를 검증한다).
      noImmediateUpdateForUser1.catch(() => {});
      outsiderNeverSeesRoomA.catch(() => {});

      // ADR-0003 결정5(RQ-18 스코프): 연결 종료는 즉시 퇴장 처리되지 않고
      // 30초 유예를 둔다 — fake timer로 유예를 진행시켜야 참여자 목록 갱신이
      // 트리거된다. 서버가 disconnect를 실제로 인지한(유예 타이머를 스케줄한)
      // 시점과 동기화한 뒤에만 fake timer를 진행시킨다(레이스 방지).
      const user2SocketId = requireSocketId(user2);
      vi.useFakeTimers();
      try {
        const serverObservedDisconnect = waitForServerSocketDisconnect(io, user2SocketId);
        user2.disconnect();
        await serverObservedDisconnect;

        // 유예 초반(1초 시점)에는 아직 즉시 처리되지 않아야 한다.
        await vi.advanceTimersByTimeAsync(1000);
        await expect(noImmediateUpdateForUser1).resolves.toBeUndefined();
        await expect(outsiderNeverSeesRoomA).resolves.toBeUndefined();

        // 남은 유예를 마저 진행시켜 30초를 넘긴다.
        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS - 1000 + 1);

        // then: 유예 경과 후에는 user1이 [alice]를 수신한다.
        const expectedAfterDisconnect: ParticipantsPayload = { room: 'room-A', participants: ['alice'] };
        await expect(user1SeesAfterDisconnect).resolves.toEqual(expectedAfterDisconnect);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
