import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-03 (specs/requirements.md §1):
 * "사용자가 room을 떠나면, 시스템은 이후 해당 room 메시지를 그 사용자에게
 * 전달하지 않아야 한다."
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-03):
 *   GA-03
 *     given: user1·user2가 room-A 참여 후 user2가 퇴장
 *     when : user1이 room-A에 메시지 전송
 *     then : user2는 수신하지 않음
 *     verify: integration_test
 *
 * 서버 계약 — 기존 (RQ-01/02에서 이미 구현된 기존 모듈,
 * src/server/createChatServer.ts. 상세는 tests/integration/rq-01-room-join.test.ts,
 * tests/integration/rq-02-message-isolation.test.ts 파일 상단 주석 참고):
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가.
 *   message({room,body}) → 서버가 room 멤버 전원에게 'message'(ChatMessage) 브로드캐스트.
 *
 * 서버 계약 — 신설 (이 테스트가 정의한다 — 아직 미구현, coder의 구현 대상):
 *   leave({room}, ack) → 해당 소켓을 room 수신자 목록에서 제거한다 (RQ-03 본체).
 *     payload: { room: string }
 *       — nickname은 재전송하지 않는다. join으로 이미 socket.data에 연결된
 *         nickname은 leave 후에도 그대로 유지된다 (leave는 room 멤버십만
 *         해제한다 — 다른 room의 멤버십이나 nickname 연결에는 영향을 주지
 *         않는다. 이 테스트는 그 범위를 검증하지 않는다).
 *     ack 콜백: (res: { ok: true } | { ok: false; error: string }) => void
 *       — join과 동일한 shape으로 일관성을 유지한다. leave가 서버에 실제로
 *         반영됐음을 클라이언트가 관측할 다른 수단이 없으므로(서버→클라
 *         이벤트로 별도 통지하지 않는다), 이 ack 수신을 "leave 완료" 동기화
 *         지점으로 사용한다 — ack를 기다린 뒤에만 다음 단계(user1의 메시지
 *         전송)로 진행해, leave emit과 message emit이 서로 다른 소켓에서
 *         발생하는 데서 오는 레이스 컨디션(서버가 leave를 아직 처리하기 전에
 *         message가 먼저 처리되는 경우)을 배제한다.
 *
 * 스코프 경계 (질문 아님 — 이 세션의 설계 결정):
 *   RQ-12(마지막 참여자가 room을 떠나면 room을 자동 삭제)는 이 RQ의 스코프가
 *   아니다. 이 테스트는 room 자체의 삭제 여부를 검증하지 않는다 — 오직
 *   "떠난 사용자(user2)가 이후 그 room 메시지를 받지 않는가"만 검증한다.
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
 * 않으면 resolve한다. 무한 대기 대신 짧은 상한(기본 250ms)으로 "room 이탈 후
 * 미수신"을 관측한다 (ADR-0005 — 모든 대기에 상한 명시).
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

type LeaveAck = { ok: true } | { ok: false; error: string };

/**
 * leave emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005).
 * RQ-03 신설 계약: 'leave' 핸들러가 아직 없으므로(정상 Red) 서버가 ack를
 * 회신하지 않아 이 대기가 timeoutMs 후 reject된다.
 */
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

describe('RQ-03 / GA-03: room을 떠난 사용자는 이후 그 room 메시지를 수신하지 않는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1·user2가 room-A 참여 후 user2가 퇴장하면, user1이 이후 room-A에 보낸 메시지를 user2는 수신하지 않는다 (RQ-03, GA-03)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1·user2가 room-A 참여
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // 양성 대조 (leave 이전): user2가 실제로 정상 수신하는 상태에서 시작함을
      // 먼저 확인한다. 이래야 이후의 "미수신"이 leave의 실제 효과이지, 애초에
      // 전송 채널이 깨져서 우연히 성립하는 무의미한 통과가 아님을 보장한다.
      const receivedBeforeLeave = waitForEvent<ChatMessage>(user2, 'message');
      user1.emit('message', { room: 'room-A', body: 'before leave' });
      const expectedBeforeLeave: ChatMessage = { room: 'room-A', nickname: 'user1', body: 'before leave' };
      await expect(receivedBeforeLeave).resolves.toEqual(expectedBeforeLeave);

      // when: user2가 room-A를 떠난다. ack로 서버가 leave를 실제로 반영한
      // 시점을 동기화한다 — leave emit(user2 소켓)과 이어지는 message
      // emit(user1 소켓)이 서로 다른 소켓이라, ack 없이 진행하면 서버가 leave를
      // 아직 처리하기 전에 message를 먼저 처리하는 레이스가 생길 수 있다.
      const leaveAck = await waitForLeaveAck(user2, { room: 'room-A' });
      expect(leaveAck.ok).toBe(true);

      // then: user1이 room-A에 다시 전송해도 user2는 수신하지 않는다.
      // 양성 대조 (leave 이후): user1 자신은 여전히 room-A 멤버이므로
      // io.to(room-A)는 발신자에게도 echo된다(RQ-02 테스트와 동일 근거 —
      // io.to()는 송신자를 배제하지 않는다). 이 echo를 함께 확인해 "브로드캐스트
      // 자체가 깨져서" user2가 우연히 미수신하는 거짓양성을 배제한다.
      const echoToSender = waitForEvent<ChatMessage>(user1, 'message');
      const notReceivedByUser2 = assertNoEvent(user2, 'message');
      user1.emit('message', { room: 'room-A', body: 'after leave' });

      const expectedAfterLeave: ChatMessage = { room: 'room-A', nickname: 'user1', body: 'after leave' };
      await expect(echoToSender).resolves.toEqual(expectedAfterLeave);
      await expect(notReceivedByUser2).resolves.toBeUndefined();
    }
  );
});
