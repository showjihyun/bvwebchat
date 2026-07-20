import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM, type ChatMessage } from '../../src/shared/types';

/**
 * RQ-04 (specs/requirements.md §1):
 * "사용자가 global 채널에 메시지를 보내면, 시스템은 접속 중인 모든 사용자에게
 * 전달해야 한다. room에 참여 중인 사용자도 global 메시지를 수신해야 한다."
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-04):
 *   GA-04
 *     given: user1은 room-A, user2는 room-B, user3은 room 미참여 (전원 접속 중)
 *     when : user1이 global에 메시지 전송
 *     then : user2·user3 모두 수신
 *     verify: integration_test
 *
 * ADR-0004(global 채널 — 예약된 상설 room, 승인) 준수 사항:
 *   결정 1: 모든 접속 사용자는 global에 자동 참여하며 탈퇴할 수 없다.
 *   결정 4: room에 참여 중인 사용자도 global 메시지를 수신한다 (RQ-04).
 *   범위 밖(이 파일이 다루지 않음 — 각 RQ 구현 시 별도 커버):
 *     RQ-12 예외(전원 접속 종료해 0명이어도 global 존속),
 *     RQ-13 예외('global' 예약 이름 room 생성 거부).
 *
 * 서버 계약 — 기존 (RQ-01/02/03에서 이미 구현된 기존 모듈,
 * src/server/createChatServer.ts. 상세는 tests/integration/rq-01-room-join.test.ts,
 * tests/integration/rq-03-leave-room.test.ts 파일 상단 주석 참고):
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가하고
 *     socket.data.nickname을 연결한다.
 *   message({room,body}) → 서버가 socket.data.nickname을 조회해 room 멤버
 *     전원에게 'message'(ChatMessage) 브로드캐스트. 발신 소켓이 payload.room의
 *     실제 멤버가 아니면(socket.rooms.has(payload.room) === false) 침묵
 *     거부한다(RQ-02). nickname이 없는 소켓의 발신도 침묵 거부한다.
 *   leave({room}, ack) → 해당 소켓을 room 수신자 목록에서 제거.
 *
 * 서버 계약 — 신설 (이 테스트가 정의한다 — 아직 미구현, coder의 구현 대상):
 *
 * 1) 자동 참여: 소켓이 접속(connection)하면 서버는 그 소켓을 GLOBAL_ROOM
 *    ('global', src/shared/types.ts) room에 자동으로 join시킨다 —
 *    클라이언트의 명시적 'join' emit 없이도 global 수신자가 된다(ADR-0004
 *    결정 1). 이 자동 참여는 기존 handleJoin과 달리 socket.data.nickname을
 *    설정하지 않는다 — nickname은 발신(message 전송)에만 필요하고 수신은
 *    room 멤버십만으로 충분하기 때문이다. 아래 GA-04 테스트의 user3이 이를
 *    증명한다: 어떤 room에도 join하지 않아 nickname이 없는 상태로 접속만
 *    했지만 global 메시지는 수신해야 한다.
 *
 * 2) leave(GLOBAL_ROOM) 거부: 아래 두 번째 describe 블록 참고 — 골든 케이스는
 *    아니며 이 세션(test-writer)이 ADR-0004 결정 1로부터 도출한 설계 결정이다.
 *
 * 부정 단언 공통 원칙 (ADR-0005): "수신하지 않는다"는 무한 대기가 아니라
 * 짧은 상한(기본 250ms) 내 이벤트 미도착으로 확인한다 (assertNoEvent 참고).
 * 이 파일에서는 부정 단언을 사용하지 않는다 — GA-04는 "수신"만 요구하고,
 * leave 거부 테스트도 "여전히 수신함"(양성)으로 검증하는 편이 "언젠가 미수신
 * 하지 않으면 통과"보다 더 강한 증거이기 때문이다.
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

describe('RQ-04 / GA-04: global 메시지는 접속 중인 모든 사용자(room 참여자·미참여자 포함)에게 전달된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1(room-A)이 global에 전송하면 user2(room-B)·user3(미참여)이 모두 수신하고, 발신자 자신(room-A 멤버)도 수신한다 (RQ-04, GA-04)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);
      const user3 = connectClient(url, cleanupFns);

      // given: user1은 room-A, user2는 room-B에 참여. user3은 의도적으로
      // 어떤 join도 호출하지 않는다(접속만 함) — 그럼에도 global 자동 참여
      // (ADR-0004 결정 1)로 global 메시지는 수신해야 한다.
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      // when: user1이 GLOBAL_ROOM('global')에 전송
      const receivedByUser2 = waitForEvent<ChatMessage>(user2, 'message');
      const receivedByUser3 = waitForEvent<ChatMessage>(user3, 'message');
      // 양성 대조: user1 자신도 room-A 멤버이면서 global 멤버이므로
      // io.to(GLOBAL_ROOM)의 echo를 받아야 한다 — RQ-04 두 번째 문장
      // ("room에 참여 중인 사용자도 global 메시지를 수신해야 한다")을
      // 발신자 자신(room-A 멤버)으로 동시에 증명한다. 이 echo가 도착하지
      // 않으면 "user2·user3 미수신"이 브로드캐스트 자체가 거부돼서 우연히
      // 성립하는 무의미한 실패/통과인지 판별할 수 없다(RQ-02/03 테스트와
      // 동일 근거).
      const echoToUser1 = waitForEvent<ChatMessage>(user1, 'message');
      user1.emit('message', { room: GLOBAL_ROOM, body: 'hello everyone' });

      // then: 전원 수신, 페이로드는 GLOBAL_ROOM으로 태그됨.
      // Promise.allSettled로 세 수신 대기를 동시에 마무리한다(개별 await 순차
      // 처리 시, 앞선 것이 먼저 reject하면 뒤따르는 promise의 거부가 처리되지
      // 않은 채 테스트 프로세스로 새어나가 "Unhandled Rejection" 잡음을
      // 일으킨다 — 셋 다 병렬로 대기 중인 이 테스트의 구조상 필연적이다).
      const expected: ChatMessage = { room: GLOBAL_ROOM, nickname: 'user1', body: 'hello everyone' };
      const [echoResult, user2Result, user3Result] = await Promise.allSettled([
        echoToUser1,
        receivedByUser2,
        receivedByUser3,
      ]);

      function expectReceived(result: PromiseSettledResult<ChatMessage>, who: string): void {
        if (result.status === 'rejected') {
          throw new Error(`${who} 수신 실패: ${String(result.reason)}`);
        }
        expect(result.value, who).toEqual(expected);
      }
      expectReceived(echoResult, 'user1(room-A 멤버, 발신자 자신)');
      expectReceived(user2Result, 'user2(room-B 멤버)');
      expectReceived(user3Result, 'user3(미참여)');
    }
  );
});

describe("RQ-04 (ADR-0004 결정 1 파생, 골든 아님): global은 leave를 시도해도 여전히 수신한다", () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    "user1이 leave({room: GLOBAL_ROOM})을 시도하면 서버가 ack({ok:false})로 거부하고, 이후에도 user1은 global 메시지를 계속 수신한다 (ADR-0004 결정 1)",
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1은 room-A에 참여(nickname 확보 목적 — 이 테스트의 발신자는
      // user2이므로 user1의 nickname 자체는 검증 대상이 아니다), user2는
      // room-B에 참여해 이후 global 발신자 역할을 한다.
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      // when: user1이 GLOBAL_ROOM을 leave 시도
      const leaveAck = await waitForLeaveAck(user1, { room: GLOBAL_ROOM });

      // then: 서버가 거부한다. 설계 결정(파일 상단 주석 참고): join의 실패 ack와
      // 동일한 shape({ok:false,error})으로 회신해 "탈퇴할 수 없다"는 계약을
      // ack 자체로 명시적으로 드러낸다(ok:true인 채 조용히 no-op하면 클라이언트가
      // "성공적으로 나갔다"고 오인해 UI 상태가 서버 상태와 어긋날 수 있다).
      expect(leaveAck.ok).toBe(false);

      // then: leave 시도 이후에도 user1은 여전히 global 멤버로서 수신한다 —
      // ack 판정만으로는 서버가 실제로 room 멤버십을 유지했는지 증명하지
      // 못하므로(ack 값만 조작하고 실제로는 leave해버리는 구현도 이 단언
      // 없이는 걸러지지 않는다), 실제 수신으로 직접 확인한다.
      const stillReceives = waitForEvent<ChatMessage>(user1, 'message');
      user2.emit('message', { room: GLOBAL_ROOM, body: 'still in global?' });
      const expected: ChatMessage = { room: GLOBAL_ROOM, nickname: 'user2', body: 'still in global?' };
      await expect(stillReceives).resolves.toEqual(expected);
    }
  );
});
