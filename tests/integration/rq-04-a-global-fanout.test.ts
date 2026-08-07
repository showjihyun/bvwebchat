import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM, type ChatMessage } from '../../src/shared/types';

/**
 * RQ-04-a (specs/requirements.md RQ-04, 개정 v1.2, 2026-08-07 — ADR-0009가
 * ADR-0004 결정4를 대체한다):
 *
 * "시스템은 global 메시지를 각 수신자가 참여 중인 모든 room 안에도 표시해야
 *  한다. 표시 범위는 수신자가 참여 중인 room이다(참여하지 않은 room에는 넣지
 *  않는다). 각 room의 이력에도 저장되어 새로고침·재접속 뒤에도 그 room에서
 *  보여야 한다. #global 채널은 그대로 유지되며 거기에도 표시된다(같은
 *  메시지가 두 곳에 보인다). room 안에 표시되는 global 메시지는 그 room의
 *  일반 메시지와 시각적으로 구분되어야 한다. 안 읽음(RQ-18) 집계는 #global만
 *  올리고 각 room은 올리지 않는다."
 *
 * ADR-0009 결정 요약: 1) 범위=수신자가 참여 중인 room만. 2) room 이력에도
 * 저장. 3) #global은 유지(중복 표시 감수). 4) 시각적 구분 필요. 5) 안 읽음은
 * #global만 오른다.
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-04):
 *
 *   GA-37
 *     given: alice·bob이 room-A에 참여 중이고 carol은 어느 room에도 미참여.
 *     when : carol이 global 채널에 메시지를 보낸다.
 *     then : alice·bob의 room-A 대화 안에 그 메시지가 표시된다 — 도착 채널이
 *            global 하나뿐이면 실패다.
 *     note : 판정은 "받았는가"가 아니라 **어느 room 태그로 왔는가**여야 한다
 *            (2026-08-07 이전 구현은 "받기만" 하면 통과했고 그것은 스펙
 *            위반이 아니었다 — RQ-04와 RQ-04-a를 가르는 지점).
 *
 *   GA-38
 *     given: alice는 room-A에만 참여(room-B 미참여). room-B에는 bob이 있다.
 *     when : carol이 global 채널에 메시지를 보낸다.
 *     then : alice는 room-A 사본만 받고 room-B 사본은 받지 않는다.
 *     note : 서버가 "모든 room에 뿌린다"로 구현하면 alice에게 room-B 태그
 *            사본이 도달해 RQ-02 격리가 global 예외로 뚫린다(ADR-0009 결정1).
 *
 *   GA-39
 *     given: alice가 room-A에 참여 중이고 global 메시지 1건이 이미 전달됐다.
 *     when : alice가 새로고침 후 동일 세션 토큰으로 재접속해 room-A를 연다.
 *     then : room-A 이력에 그 global 메시지가 남아 있다.
 *     note : 실시간 표시만 구현하면 접속 중에만 참인 약속이 된다. "클라이언트
 *            합성"(서버는 global 이력만 갖고 클라이언트가 화면에서 시간순으로
 *            섞는다) 대안도 이 케이스가 막는다 — 서버 이력에 없으면 실패한다
 *            (ADR-0009 결정2, 버린 대안).
 *
 *   GA-40
 *     given: alice가 room-A·room-B에 참여 중이고 지금 room-A를 보고 있다.
 *     when : carol이 global 채널에 메시지를 보낸다.
 *     then : room-B의 안 읽음 수는 오르지 않고 global의 안 읽음 수만 오른다.
 *     note : 메시지가 room-B에도 전달되므로(GA-38의 전제) RQ-18의 기존
 *            fanOutUnread를 그 room-B 사본에도 그대로 적용하면 이 단언이
 *            깨진다 — **전달과 집계를 분리해야 통과한다**(ADR-0009 결정5).
 *
 * ── 서버 계약 — 기존 (변경 없음, 이 파일이 재사용만 한다) ──
 *   identify(payload:{nickname}, ack) → 세션 토큰 발급(ADR-0003). global 발신
 *     처럼 room에 join하지 않고 nickname만 필요할 때 이 경로를 쓴다(RQ-18
 *     GA-16과 동일 관례) — join은 예약 이름 'global'을 거부하기 때문이다.
 *   join(payload:{room,nickname}, ack) → { ok:true, history } | { ok:false }.
 *     history는 그 room의 최근 메시지 링버퍼 스냅샷(RQ-11, ADR-0002 상한 50).
 *   message(payload:{room,body}) → 서버가 socket.data.nickname을 조회해
 *     room 멤버 전원에게 'message'(ChatMessage) 브로드캐스트 + 링버퍼 저장
 *     (appendMessage) + 비활성 세션 안 읽음 +1(fanOutUnread, RQ-18).
 *   resume(payload:{token}, ack) → 세션을 새 소켓에 재바인딩하고 참여
 *     중이던 모든 room(global 포함)에 socket.join만 수행한다 — **history는
 *     포함하지 않는다**(session.ts 주석: "히스토리 ack도... 건너뛰는 별개
 *     경로다"). 이것이 GA-39가 재접속 뒤 "room-A를 연다"를 별도 join
 *     재호출로 모델링하는 이유다(아래 GA-39 절 참고).
 *   activeRoom(payload:{room}, ack) → 세션의 활성 room을 갱신하고 그 room
 *     안 읽음을 0으로 초기화(RQ-18).
 *
 * ── 서버 계약 — 신설 (이 파일이 정의한다. 아직 미구현, coder의 구현 대상) ──
 *
 * 1) room 사본 fan-out: message(payload:{room: GLOBAL_ROOM, body})가
 *    도착하면, 기존 `io.to(GLOBAL_ROOM).emit('message', ...)`에 **더해**,
 *    이 메시지를 받을 각 세션에 대해 — 그 세션이 참여 중인 **non-global**
 *    room마다 — `{ room: <그 room 이름>, nickname, body }` 모양의 사본을
 *    그 room 멤버 전원에게 전달한다(GA-37). 이 사본의 `room` 필드는 원래
 *    목적지였던 GLOBAL_ROOM이 아니라 **수신자가 참여 중인 room의 이름**으로
 *    태그된다 — GA-37의 note가 요구하는 판정 기준이다.
 * 2) 범위: 사본은 **그 세션이 실제로 참여 중인 room에만** 간다. 서버에
 *    존재하는 모든 room이 아니다(GA-38, ADR-0009 결정1).
 * 3) 이력 저장: 각 사본은 그 room의 링버퍼(state.histories, ADR-0002 상한
 *    50)에도 저장된다 — 그 room의 다음 'join' ack의 history에 포함되어야
 *    한다(GA-39, ADR-0009 결정2).
 * 4) 안 읽음 분리: 각 사본의 전달은 **그 room의 안 읽음을 올리지 않는다**.
 *    GLOBAL_ROOM 자체에 대한 기존 fanOutUnread(RQ-18)만 그대로 동작한다
 *    (GA-40, ADR-0009 결정5).
 *
 * ── 현재 구현(2026-08-07, 이 파일 작성 시점)과의 차이 ──
 *   `src/server/chat/room.ts:89` handleMessage는 `payload.room`
 *   (GLOBAL_ROOM으로 온 메시지면 GLOBAL_ROOM 그 자체) 하나에 대해서만
 *   `io.to().emit` + `appendMessage` + `fanOutUnread`를 수행한다. 수신자가
 *   참여 중인 다른 room으로의 복제는 전혀 없다 — 위 신설 계약 1~4가 전부
 *   미구현이므로 아래 네 테스트가 전부 실패해야 한다.
 *
 * ── 범위 밖(이 파일이 직접 규정하지 않음, `_workspace/RQ-04-a/plan.md`가 이미 답함) ──
 *   스펙 v1.2 다섯 번째 불릿·ADR-0009 결정4("room 안 global 메시지는 시각적
 *   구분")는 GA-37~40 어느 `then`에도 없다 — 골든 없는 acceptance criterion
 *   이다. `plan.md` §2-4가 이미 메커니즘을 정해 뒀다: 사본에만(원본 #global
 *   메시지에는 붙이지 않는다) `ChatMessage.origin?: 'global'`을 싣는다.
 *   이 필드는 `src/shared/types.ts`에 속하고 RED 단계는 `src/**`를 쓸 수
 *   없으므로(phase-gate) 이 세션이 타입을 확정할 수 없다 — 그래서 아래
 *   room-태그 사본 단언은 전부 `toEqual`이 아니라 `toMatchObject`/
 *   `expect.objectContaining`을 쓴다: room·nickname·body 세 필드만 확인하고
 *   `origin`의 유무·값은 판정하지 않는다. `toEqual`(엄격 동치)을 썼다면,
 *   plan.md대로 origin을 올바르게 붙인 GREEN 구현이 오히려 이 테스트를
 *   깨뜨리는 역설이 생긴다 — "정당한 구현이 Red 테스트를 못 넘는" 것은
 *   테스트 결함이지 구현 결함이 아니다. origin 자체의 존재·값 검증은 이
 *   골든 세트의 범위가 아니므로 이 파일은 검증하지 않는다(coder/evaluator가
 *   plan.md 기준으로 별도 판단).
 *
 * 부정 단언 공통 원칙(ADR-0005): "받지 않는다"는 무한 대기가 아니라 짧은
 * 상한(기본 300ms) 내 이벤트 미도착으로 확인한다.
 */

/** 지정 room으로 태그된 nickname·body와 함께 'message' 이벤트를 기다린다 (RQ-04, GA-37/38/39/40). */
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

type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };

/** identify emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForIdentifyAck(
  socket: ClientSocket,
  payload: { nickname: string },
  timeoutMs = 2000
): Promise<IdentifyAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'identify' ack가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.emit('identify', payload, (ack: IdentifyAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

type ResumeAck =
  | { ok: true; nickname: string; rooms: string[]; activeRoom: string | null; unread: Record<string, number> }
  | { ok: false; error: string };

/** resume emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForResumeAck(socket: ClientSocket, payload: { token: string }, timeoutMs = 2000): Promise<ResumeAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'resume' ack가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.emit('resume', payload, (ack: ResumeAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

type ActiveRoomAck = { ok: true } | { ok: false; error: string };

/** activeRoom emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForActiveRoomAck(
  socket: ClientSocket,
  payload: { room: string },
  timeoutMs = 2000
): Promise<ActiveRoomAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'activeRoom' ack가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.emit('activeRoom', payload, (ack: ActiveRoomAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

interface UnreadPayload {
  room: string;
  count: number;
}

/** 지정 room에 대한 다음 'unread' 이벤트를 기다린다(다른 room의 이벤트는 무시). */
function waitForUnreadEvent(socket: ClientSocket, room: string, timeoutMs = 2000): Promise<UnreadPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('unread', onUnread);
      reject(new Error(`'unread' 이벤트(room=${room})가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    function onUnread(payload: UnreadPayload): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('unread', onUnread);
      resolve(payload);
    }
    socket.on('unread', onUnread);
  });
}

/** 지정 room에 대한 'unread' 이벤트가 timeoutMs 내에 절대 도착하지 않아야 함을 확인하는 부정 단언(ADR-0005). */
function assertNoUnreadEventForRoom(socket: ClientSocket, room: string, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('unread', onUnread);
      resolve();
    }, timeoutMs);
    function onUnread(payload: UnreadPayload): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('unread', onUnread);
      reject(new Error(`'unread' 이벤트(room=${room})가 도착해서는 안 되는데 도착했다: ${JSON.stringify(payload)}`));
    }
    socket.on('unread', onUnread);
  });
}

/**
 * 지정 room으로 태그된 'message' 이벤트를 기다린다(다른 room 태그의 이벤트는
 * 무시). 판정 기준은 "수신 여부"가 아니라 "어느 room 태그로 왔는가"다(GA-37
 * note) — 이 헬퍼가 그 판정을 구현한다.
 */
function waitForRoomMessage(socket: ClientSocket, room: string, timeoutMs = 2000): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`'message'(room=${room}) 이벤트가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    function onMessage(payload: ChatMessage): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(payload);
    }
    socket.on('message', onMessage);
  });
}

/**
 * 지정 room으로 태그된 'message' 이벤트가 timeoutMs 내에 절대 도착하지
 * 않아야 함을 확인하는 부정 단언(ADR-0005 — 짧은 상한, 무한 대기 아님).
 * GA-38(범위 = 수신자가 참여 중인 room만, ADR-0009 결정1)의 핵심 단언.
 */
function assertNoRoomMessage(socket: ClientSocket, room: string, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(payload: ChatMessage): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(new Error(`'message'(room=${room}) 이벤트가 도착해서는 안 되는데 도착했다: ${JSON.stringify(payload)}`));
    }
    socket.on('message', onMessage);
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

/** 실 네트워크 왕복 사이의 짧은 실 지연(새로고침 모사, GA-39). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('RQ-04-a / GA-37: room에 참여 중인 사용자는 global 메시지를 그 room 태그로도 받는다 — global 태그 하나뿐이면 실패', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice·bob이 room-A에 참여 중이고 carol(어느 room에도 미참여)이 global에 메시지를 보내면, alice·bob 모두 room-A로 태그된 사본을 받는다 (RQ-04, GA-37)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice = connectClient(url, cleanupFns);
      const bob = connectClient(url, cleanupFns);
      const carol = connectClient(url, cleanupFns);

      // given: alice·bob이 room-A에 참여. carol은 어느 room에도 참여하지
      // 않고 identify로만 nickname을 확보한다 — global 발신은 nickname만
      // 있으면 충분하고, join은 예약 이름 'global'을 거부하기 때문이다
      // (RQ-18 GA-16과 동일 관례).
      expect((await waitForJoinAck(alice, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
      expect((await waitForJoinAck(bob, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);
      const carolIdentify = await waitForIdentifyAck(carol, { nickname: 'carol' });
      if (!carolIdentify.ok) throw new Error(`carol identify 실패: ${carolIdentify.error}`);

      // when: carol이 GLOBAL_ROOM에 발신한다. 관찰자는 트리거 전에 등록한다.
      // 판정은 "받았는가"가 아니라 "어느 room 태그로 왔는가"다(골든 note) —
      // room-A로 태그된 'message'만 기다린다. 도착 채널이 여전히 global
      // 하나뿐인 구현(이 파일 작성 시점의 기존 코드)에서는 이 promise가
      // 절대 resolve되지 않고 타임아웃으로 실패한다.
      const aliceSeesRoomTag = waitForRoomMessage(alice, 'room-A');
      const bobSeesRoomTag = waitForRoomMessage(bob, 'room-A');
      carol.emit('message', { room: GLOBAL_ROOM, body: 'hello everyone' });

      // then: alice·bob의 room-A 대화 안에 그 메시지가 표시된다 — room 태그가
      // 'room-A'이고 발신자·본문은 보존된다. Promise.allSettled로 동시에
      // 마무리해 한쪽 reject가 다른 쪽 대기를 처리되지 않은 거부로 새어나가지
      // 않게 한다(rq-04-global-broadcast.test.ts와 동일 근거).
      const expected: ChatMessage = { room: 'room-A', nickname: 'carol', body: 'hello everyone' };
      const [aliceResult, bobResult] = await Promise.allSettled([aliceSeesRoomTag, bobSeesRoomTag]);
      function expectReceived(result: PromiseSettledResult<ChatMessage>, who: string): void {
        if (result.status === 'rejected') {
          throw new Error(`${who} room-A 태그 수신 실패: ${String(result.reason)}`);
        }
        expect(result.value, who).toMatchObject(expected);
      }
      expectReceived(aliceResult, 'alice(room-A 멤버)');
      expectReceived(bobResult, 'bob(room-A 멤버)');
    }
  );
});

describe('RQ-04-a / GA-38: global 메시지의 room 사본은 수신자가 참여 중인 room에만 간다 (ADR-0009 결정1)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice가 room-A에만 참여(room-B 미참여, room-B에는 bob이 있음)한 상태에서 carol이 global에 보내면 alice는 room-A 사본만 받고 room-B 사본은 받지 않는다 (RQ-04, GA-38)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice = connectClient(url, cleanupFns);
      const bob = connectClient(url, cleanupFns);
      const carol = connectClient(url, cleanupFns);

      // given: alice는 room-A에만, bob은 room-B에만 참여한다 — room-B를
      // "실제로 존재하고 멤버가 있는 room"으로 만들어 "모든 room에 뿌린다"
      // 오구현이 성립할 수 있는 현실적인 상황을 만든다(골든 note).
      expect((await waitForJoinAck(alice, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
      expect((await waitForJoinAck(bob, { room: 'room-B', nickname: 'bob' })).ok).toBe(true);
      const carolIdentify = await waitForIdentifyAck(carol, { nickname: 'carol' });
      if (!carolIdentify.ok) throw new Error(`carol identify 실패: ${carolIdentify.error}`);

      // when: 트리거 직전에 양성·부정 관찰자를 모두 등록한다 — 도착 순서를
      // 가정하지 않고 동시에 결론짓기 위함(rq-18의 assertNoUnreadEventForRoom
      // 페어링과 동일 원칙).
      const aliceSeesRoomA = waitForRoomMessage(alice, 'room-A');
      const aliceNeverSeesRoomB = assertNoRoomMessage(alice, 'room-B', 300);
      carol.emit('message', { room: GLOBAL_ROOM, body: 'hello everyone' });

      // then(positive): alice는 room-A 사본을 받는다 — "room-B 사본만
      // 안 온다"가 아니라 "room-A 사본만 온다"는 골든 문장 그대로 확인한다.
      const expected: ChatMessage = { room: 'room-A', nickname: 'carol', body: 'hello everyone' };
      await expect(aliceSeesRoomA).resolves.toMatchObject(expected);

      // then(negative): alice는 room-B 사본을 받지 않는다 — 서버가 "모든
      // room에 뿌린다"로 구현하면(참여 여부와 무관하게 존재하는 모든 room에
      // 태그 사본을 유니캐스트) 이 단언이 깨진다(골든 note, ADR-0009 결정1).
      await expect(aliceNeverSeesRoomB).resolves.toBeUndefined();
    }
  );
});

describe('RQ-04-a / GA-39: room 안의 global 사본은 그 room 이력에도 저장되어 재접속 뒤에도 남는다 (ADR-0009 결정2)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice가 room-A에 참여 중일 때 carol이 global에 보낸 메시지가 room-A에 전달된 뒤, alice가 연결을 끊고(새로고침 모사) 동일 세션 토큰으로 재접속해 room-A를 다시 열면 그 메시지가 room-A 이력에 남아 있다 (RQ-04, GA-39)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice = connectClient(url, cleanupFns);
      const carol = connectClient(url, cleanupFns);

      // given: alice가 세션(identify)을 얻고 room-A에 참여한다. carol이
      // global에 보낸 메시지가 이미 room-A에 전달된 상태를 만든다 — GA-37이
      // 증명한 라이브 전달을 여기서도 실제로 지나가, "이미 전달됐다"는
      // given을 가정이 아니라 실행으로 확보한다.
      const aliceIdentify = await waitForIdentifyAck(alice, { nickname: 'alice' });
      if (!aliceIdentify.ok) throw new Error(`alice identify 실패: ${aliceIdentify.error}`);
      const token = aliceIdentify.token;
      expect((await waitForJoinAck(alice, { room: 'room-A', nickname: aliceIdentify.nickname })).ok).toBe(true);
      const carolIdentify = await waitForIdentifyAck(carol, { nickname: 'carol' });
      if (!carolIdentify.ok) throw new Error(`carol identify 실패: ${carolIdentify.error}`);

      const aliceSeesRoomA = waitForRoomMessage(alice, 'room-A');
      carol.emit('message', { room: GLOBAL_ROOM, body: 'persisted announcement' });
      const expected: ChatMessage = { room: 'room-A', nickname: 'carol', body: 'persisted announcement' };
      await expect(aliceSeesRoomA).resolves.toMatchObject(expected);

      // when: alice가 새로고침한다 — 연결을 끊고 짧은 실 지연 후 동일 토큰으로
      // 재접속(resume)한다. 유예(30초) 경계 자체를 검증하는 테스트가 아니므로
      // fake timer는 쓰지 않는다(rq-15-b GA-35/36의 "새로고침 모사" 관례와 동일).
      alice.disconnect();
      await sleep(150);

      const alice2 = connectClient(url, cleanupFns);
      await new Promise<void>((resolve) => alice2.on('connect', () => resolve()));
      const resumeAck = await waitForResumeAck(alice2, { token });
      if (!resumeAck.ok) throw new Error(`resume 실패: ${resumeAck.error}`);

      // "room-A를 연다" — 이 서버 계약에서 room 이력을 돌려주는 유일한
      // 이벤트는 'join' ack뿐이다. resume ack에는 history가 없다
      // (session.ts 주석: handleResume은 handleJoin을 재사용하지 않으므로
      // "히스토리 ack도... 건너뛰는 별개 경로다"). 재접속한 소켓은 이미
      // resume이 socket.join('room-A')로 재합류시켰으므로(session.ts:307)
      // 이 재-join emit은 멤버십을 새로 만드는 것이 아니라 순수히 이력
      // 조회 목적이다.
      // (test-writer 메모: addMember는 중복 제거를 하지 않으므로 members
      // 장부에 alice의 새 socket.id가 이미 resume에서 등록된 뒤 이 재-join
      // 으로 한 번 더 push될 수 있다 — 이 테스트는 participants/members를
      // 단언하지 않으므로 그 부작용은 이 테스트의 관심사가 아니다.)
      const reopenAck = await waitForJoinAck(alice2, { room: 'room-A', nickname: aliceIdentify.nickname });

      // then: room-A 이력에 그 global 메시지가 남아 있다. 실시간 표시만
      // 구현하거나(저장 없음) "클라이언트 합성" 대안으로 대체하면(서버
      // 이력에 없음) 이 단언이 깨진다(골든 note, ADR-0009 결정2·버린 대안).
      if (!reopenAck.ok) throw new Error(`room-A 재-join 실패: ${reopenAck.error}`);
      expect(reopenAck.history).toContainEqual(expect.objectContaining(expected));
    }
  );
});

describe('RQ-04-a / GA-40: room 안의 global 사본은 그 room의 안 읽음을 올리지 않는다 — global 안 읽음만 오른다 (ADR-0009 결정5)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice가 room-A·room-B에 참여하고 지금 room-A를 보고 있는 상태에서 carol이 global에 보내면 room-B의 안 읽음은 오르지 않고 global의 안 읽음만 오른다 (RQ-04, GA-40)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice = connectClient(url, cleanupFns);
      const carol = connectClient(url, cleanupFns);

      // given: alice가 세션을 얻고 room-A·room-B에 참여, 활성 room을
      // room-A로 통지한다.
      const aliceIdentify = await waitForIdentifyAck(alice, { nickname: 'alice' });
      if (!aliceIdentify.ok) throw new Error(`alice identify 실패: ${aliceIdentify.error}`);
      expect((await waitForJoinAck(alice, { room: 'room-A', nickname: aliceIdentify.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(alice, { room: 'room-B', nickname: aliceIdentify.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(alice, { room: 'room-A' })).ok).toBe(true);
      const carolIdentify = await waitForIdentifyAck(carol, { nickname: 'carol' });
      if (!carolIdentify.ok) throw new Error(`carol identify 실패: ${carolIdentify.error}`);

      // when: 트리거 직전에 관찰자 셋을 모두 등록한다.
      //   1) global 안 읽음이 오른다(양성) — RQ-18 기존 동작, 이 케이스가
      //      새로 규정하는 것은 아니지만 "전달"과 "집계"를 같은 트리거로
      //      함께 확인해야 아래 3)이 의미를 갖는다.
      //   2) room-B도 실제로 메시지 사본을 받는다(양성) — GA-38 스코프의
      //      전제를 이 테스트 안에서도 실제로 지나간다. 이 확인이 없으면
      //      "room-B fan-out 자체가 미구현"인 경우에도 3)의 부정 단언이
      //      아무것도 안 와서 우연히 통과하는 무의미한 그린이 된다.
      //   3) 그런데도 room-B 안 읽음 이벤트는 전혀 발생하지 않는다(부정,
      //      이 케이스의 핵심) — 메시지가 room-B에도 전달되므로(2) RQ-18의
      //      기존 fanOutUnread를 그 room-B 사본에도 그대로 적용하면 이
      //      단언이 깨진다(골든 note: "전달과 집계를 분리해야 통과한다").
      const globalUnreadConverges = waitForUnreadEvent(alice, GLOBAL_ROOM);
      const roomBReceivesMessage = waitForRoomMessage(alice, 'room-B');
      const roomBNeverIncrementsUnread = assertNoUnreadEventForRoom(alice, 'room-B', 300);
      carol.emit('message', { room: GLOBAL_ROOM, body: 'announcement' });

      const globalPayload = await globalUnreadConverges;
      const expectedGlobalUnread: UnreadPayload = { room: GLOBAL_ROOM, count: 1 };
      expect(globalPayload).toEqual(expectedGlobalUnread);

      const expectedRoomBMessage: ChatMessage = { room: 'room-B', nickname: 'carol', body: 'announcement' };
      await expect(roomBReceivesMessage).resolves.toMatchObject(expectedRoomBMessage);

      await expect(roomBNeverIncrementsUnread).resolves.toBeUndefined();
    }
  );
});
