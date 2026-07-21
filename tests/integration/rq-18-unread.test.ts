import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM, type RoomName } from '../../src/shared/types';

/**
 * RQ-18 (specs/requirements.md §2-1, v1.1):
 * "사용자가 참여 중인 room(global 포함)에 새 메시지가 전달되었을 때 그 room이
 * 그 사용자의 활성 room(ADR-0003 정의)이 아니면, 시스템은 그 room의 안 읽음
 * 개수를 1 증가시켜야 한다. 사용자가 그 room을 활성 room으로 전환하면,
 * 시스템은 그 room의 안 읽음 개수를 0으로 초기화해야 한다. 안 읽음 개수는
 * 사용자 세션(RQ-10 식별 기준)별로 서버가 보관하며, 참여 상태가 유지되는
 * 동안 복원되어야 한다(새로고침 및 ADR-0003의 퇴장 유예 30초 내 재접속 포함.
 * 유예 만료로 퇴장이 확정되거나 서버가 재시작하면 소실되며, 이는 RQ-11의
 * 영속성 정책과 동일하다)."
 *
 *   범위 제약 ①: 참여하지 않은 room은 대상이 아니다 (RQ-02 격리).
 *   범위 제약 ②: 안 읽음 개수는 해당 room의 보관 메시지 수(ADR-0002 링버퍼
 *     50개)를 상한으로 한다 — 열었을 때 이미 밀려나 볼 수 없는 메시지는
 *     세지 않는다.
 *
 * 이 RQ는 ADR-0003(사용자 식별 — 닉네임 + 서버 발급 세션 토�큰) 전문을 스펙으로
 * 삼는다 — 결정1-2(세션 토큰), 결정3(신뢰경계/세션상태), 결정4(활성 room),
 * 결정5(30초 퇴장 유예) 전부.
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-18):
 *   GA-12
 *     given: user1이 room-A·room-B 참여, 활성 room을 room-A로 통지
 *     when : user2가 room-B에 메시지 2개 전송
 *     then : user1의 room-B 안 읽음=2, 활성 room인 room-A는 0 유지
 *   GA-13
 *     given: room-B 안 읽음=2, 활성 room은 room-A
 *     when : user1이 활성 room을 room-B로 통지
 *     then : room-B 안 읽음이 0으로 초기화
 *   GA-14
 *     given: room-B 안 읽음=2
 *     when : user1이 새로고침 후 동일 세션 토큰으로 재접속(퇴장 유예 30초 내)
 *     then : room-B 안 읽음=2로 복원
 *   GA-15
 *     given: user1은 room-A만 참여(room-B 미참여), 활성 room은 room-A
 *     when : user2가 room-B에 메시지 전송
 *     then : user1에게 room-B 안 읽음이 생기지 않음 (RQ-02 격리)
 *   GA-16
 *     given: user1의 활성 room이 room-A (global 자동 참여)
 *     when : user2가 global에 메시지 전송
 *     then : user1의 global 안 읽음=1
 *   GA-17
 *     given: user1이 room-A·room-B 참여, 활성 room은 room-B (room-A 링버퍼 상한 50)
 *     when : user2가 room-A에 메시지 60개 전송
 *     then : user1의 room-A 안 읽음=정확히 50
 *   GA-18
 *     given: user1이 room-A에 참여, 활성 room은 room-A
 *     when : user1이 미참여 room-C를 활성 room으로 통지 시도
 *     then : 서버가 거부(활성 room은 참여 room이어야 한다)
 *
 * ── 서버 계약 — 변경 (identify, 기존 이벤트 확장) ──
 *
 * identify(payload: { nickname: string }, ack)
 *   IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string }
 *   - 기존 계약(RQ-10, GA-09/11)은 그대로 유지한다(닉네임 고유화 로직 불변).
 *   - **추가**: 성공 시 서버가 새로 발급한 불투명 세션 토큰을 함께 반환한다
 *     (ADR-0003 결정1). 토큰 형식은 강제하지 않는다 — "비어있지 않은 문자열"
 *     이고 호출마다 달라야 한다는 것만 이 파일이 단언한다(아래 파생 테스트).
 *   - identify는 token 파라미터를 받지 않는다 — "새 신원 발급"과 "기존 세션
 *     복원"을 의도적으로 분리한다(아래 resume 참고). 기존 rq-10 테스트가
 *     token 없이 identify만 호출하는 흐름을 그대로 유지하므로 회귀가 없다.
 *   - identify가 성공하면 그 소켓에 세션이 바인딩된다(socket.data 등, 구현
 *     자유). 이후 같은 소켓에서의 join/leave/message/activeRoom 호출은 별도로
 *     token을 재전송하지 않아도 이 세션에 자동 귀속되어야 한다 — 이는
 *     resume(새 소켓에서 명시적으로 token을 제시하는 경우)과의 유일한 차이다.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다. 아직 미구현, coder의 구현 대상) ──
 *
 * 1) resume(payload: { token: string }, ack) — ADR-0003 결정1-2, 결정5.
 *    ResumeAck =
 *      | { ok: true; nickname: string; rooms: RoomName[]; activeRoom: RoomName | null;
 *          unread: Record<RoomName, number> }
 *      | { ok: false; error: string }
 *    - token이 살아있는 세션(연결 중 또는 퇴장 유예 30초 이내)에 대응하면:
 *      그 세션을 이 새 소켓에 재바인딩하고, 세션이 참여 중이던 모든
 *      room(join으로 참여한 room + 자동 참여 global)에 이 소켓을 실제로
 *      재합류(socket.join)시켜 이후 메시지 라우팅·참여자 목록(RQ-15)이
 *      끊김 없이 이어지게 한다. 대기 중인 퇴장 확정 타이머(아래 4번)를
 *      취소한다. ack에 복원된 nickname·참여 room 목록·활성 room·room별
 *      안 읽음 개수 전체를 담아 반환한다(GA-14).
 *    - token이 없거나(미발급) 이미 퇴장이 확정된 뒤(유예 만료)면 ok:false로
 *      거부한다.
 *
 * 2) activeRoom(payload: { room: string }, ack) — ADR-0003 결정4.
 *    ActiveRoomAck = { ok: true } | { ok: false; error: string }
 *    - payload.room이 이 세션의 현재 참여 room(global 포함)이 아니면 거부
 *      (ok:false) — 활성 room 불변(GA-18, GA-10과 동일 원칙: 격리는 서버가
 *      강제한다).
 *    - 참여 room이면: 세션의 활성 room을 그 값으로 설정하고, 그 room의 안
 *      읽음 개수를 0으로 초기화한 뒤 unread(아래 3번) 이벤트로 통지한다
 *      (GA-13). 세션당 활성 room은 하나뿐이며 마지막 통지가 이긴다(다중 탭
 *      공유 세션의 수용된 한계, ADR-0003 결정4).
 *    - 세션 생성 직후(이 이벤트를 한 번도 받기 전)에는 활성 room이 없다
 *      (null) — 이 상태에서는 참여 중인 모든 room이 안 읽음 집계 대상이다
 *      (파생 테스트로 검증).
 *    - 참여 중이던 room에서 leave(RQ-03)하면, 그 room이 활성 room이었을
 *      경우 활성 room은 다시 없음(null)으로 되돌아간다(파생 테스트로 검증).
 *
 * 3) unread(payload: { room: RoomName; count: number }) — 서버→클라이언트
 *    **유니캐스트**(그 세션의 현재 소켓에만 전달 — room 전체 브로드캐스트가
 *    아니다).
 *    - 트리거 A(증가): 세션이 참여 중인 room(global 포함)에 메시지가
 *      도착했는데 그 room이 세션의 활성 room이 아니면, 그 room의 안 읽음을
 *      1 증가시키고 이 이벤트로 통지한다.
 *    - 트리거 B(초기화): activeRoom()으로 그 room이 활성으로 전환되면 0으로
 *      통지한다(위 2번).
 *    - 상한(범위 제약 ②, GA-17): 증가는 그 room의 현재 보관 메시지 수
 *      (ADR-0002 링버퍼 상한 50)를 넘지 않도록 클램프한다 — 50이 그 room이
 *      가질 수 있는 최대 보관 메시지 수이기도 하므로 두 해석(상한=50 상수 /
 *      상한=현재 보관 메시지 수)은 이 시나리오에서 항상 일치한다.
 *    - 미참여 room은 세션의 "참여 room 집합"에 애초에 없으므로 이 이벤트가
 *      발생할 수 없다(GA-15, 범위 제약 ①).
 *
 * 4) 퇴장 유예 30초 (ADR-0003 결정5) — 세션 유무와 무관하게 **모든 소켓
 *    disconnect에 적용**되는 일반 규칙이다(identify를 호출하지 않은
 *    세션리스 소켓도 포함 — 아래 "기존 disconnect 테스트 정합" 참고):
 *    - 소켓 연결이 끊기면 기존의 즉시 퇴장 처리(roomMembers 제거·
 *      participants/rooms 브로드캐스트·RQ-12 빈 room 삭제·nickname 해제)를
 *      **즉시 실행하지 않고** 30초 뒤로 미룬다.
 *    - 그 30초 안에 (토큰을 가진 세션이라면) resume(같은 token)이 도착하면
 *      타이머를 취소하고 위 즉시 퇴장 처리를 전혀 실행하지 않는다 —
 *      참여자 목록 등에 이탈이 전혀 관측되지 않아야 한다.
 *    - 30초가 지나도록 resume이 없으면 퇴장을 확정한다 — 이 시점에 기존
 *      즉시 퇴장 처리 전체를 실행하고, **추가로 그 세션의 안 읽음 개수
 *      전체를 버린다**(ADR-0003 결정5 마지막 문장, GA-18 범위 밖의 세션
 *      정리 — 이 파일 하단 파생 테스트로 검증).
 *    - 경계값 해석: "30초"를 정확히 30000ms로 보되, 테스트는 경계 오차를
 *      피하기 위해 유예 내 확인은 29000ms, 만료 확인은 30001ms로 fake
 *      timer를 진행시킨다(vi.useFakeTimers + vi.advanceTimersByTimeAsync —
 *      ADR-0005 결정4).
 *
 * ── 세션리스 소켓 회귀 방지 (중요 — coder에게) ──
 * 기존 RQ-01/02/03/04/12/13/14/15 골든 대부분은 identify를 전혀 호출하지
 * 않고 join의 nickname 필드만으로 동작한다(예: GA-25). 이 RQ의 세션·토큰·
 * 활성 room·안 읽음 로직은 **identify를 호출한 소켓에만 적용되는 부가
 * 레이어**여야 한다 — identify를 호출한 적 없는 소켓의 join/leave/message는
 * 세션이 없으므로 안 읽음 집계를 그냥 건너뛰고, 기존 동작(RQ-01~15)을 그대로
 * 유지해야 한다. 단, 4번(30초 유예)은 세션 유무와 무관하게 모든 disconnect에
 * 적용된다(아래 "기존 disconnect 테스트 정합" 참고) — resume 능력만 세션(토큰)
 * 보유 여부에 좌우된다.
 *
 * ── 기존 disconnect 테스트 정합 (team-lead 지시, 이 세션이 수행) ──
 * 30초 유예(위 4번)는 "연결 종료 시 즉시 퇴장 처리 안 함"이므로, 다음 두 파일의
 * disconnect 경로 테스트가 요구하던 "즉시 제거"와 충돌한다. 두 파일 모두
 * **단언은 보존**(제거가 결국 일어남)하고 **타이밍만 교정**(즉시 → 유예 30초
 * 경과 후, fake timer)했다 — leave 경로 테스트는 손대지 않았다:
 *   - tests/integration/rq-15-participants.test.ts — GA-20 disconnect 경로
 *     (leave 경로는 무변경)
 *   - tests/integration/rq-12-room-lifecycle.test.ts — GA-26 disconnect
 *     파생(골든 아님. GA-26 자체는 leave 경로라 무변경)
 * 상세 diff와 근거는 _workspace/RQ-18/01_test-writer_red.md 참고.
 *
 * 부정 단언 공통 원칙(ADR-0005): "수신하지 않는다"는 무한 대기가 아니라 짧은
 * 상한(기본 300ms) 내 이벤트 미도착으로 확인한다.
 */

/** RQ-18 신설 계약 — identify ack 확장(파일 상단 주석 참고). */
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

/** 기존 join 계약(RQ-01) 재사용 — 이 파일은 history 필드를 쓰지 않는다. */
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

/** 기존 leave 계약(RQ-03) 재사용. */
type LeaveAck = { ok: true } | { ok: false; error: string };

/** leave emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForLeaveAck(socket: ClientSocket, payload: { room: string }, timeoutMs = 2000): Promise<LeaveAck> {
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

/** RQ-18 신설 계약 — activeRoom ack (파일 상단 주석 참고). */
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

/** RQ-18 신설 계약 — resume ack (파일 상단 주석 참고). */
type ResumeAck =
  | { ok: true; nickname: string; rooms: RoomName[]; activeRoom: RoomName | null; unread: Record<RoomName, number> }
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

/** RQ-18 신설 계약 — 서버→클라이언트 유니캐스트 안 읽음 통지(파일 상단 주석 참고). */
interface UnreadPayload {
  room: RoomName;
  count: number;
}

/** 지정 room에 대한 다음 'unread' 이벤트를 기다린다(다른 room의 이벤트는 무시). */
function waitForUnreadEvent(socket: ClientSocket, room: RoomName, timeoutMs = 2000): Promise<UnreadPayload> {
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

/**
 * 지정 room에 대해 count가 expectedCount에 도달하는 'unread' 이벤트를
 * 수렴 방식으로 기다린다(rq-12/rq-13의 waitForRoomsConvergence와 동일 근거 —
 * 중간값을 잘못 소비하는 경합을 피한다). GA-12/13/14의 "given" 단계(안 읽음을
 * 특정 값까지 쌓기)에 사용한다.
 */
function waitForUnreadConvergence(
  socket: ClientSocket,
  room: RoomName,
  expectedCount: number,
  timeoutMs = 5000
): Promise<UnreadPayload> {
  return new Promise((resolve, reject) => {
    const received: number[] = [];
    const timer = setTimeout(() => {
      socket.off('unread', onUnread);
      reject(
        new Error(
          `'unread' 이벤트(room=${room})가 ${timeoutMs}ms 내에 count=${expectedCount}로 수렴하지 않았다 ` +
            `(수신 이력: ${JSON.stringify(received)})`
        )
      );
    }, timeoutMs);
    function onUnread(payload: UnreadPayload): void {
      if (payload.room !== room) return;
      received.push(payload.count);
      if (payload.count === expectedCount) {
        clearTimeout(timer);
        socket.off('unread', onUnread);
        resolve(payload);
      }
    }
    socket.on('unread', onUnread);
  });
}

/**
 * 지정 room에 대한 'unread' 이벤트가 timeoutMs 내에 절대 도착하지 않아야
 * 함을 확인하는 부정 단언(ADR-0005 — 짧은 상한, 무한 대기 아님).
 */
function assertNoUnreadEventForRoom(socket: ClientSocket, room: RoomName, timeoutMs = 300): Promise<void> {
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
 * 지정 room에 대한 'message' 이벤트가 정확히 count개 도착할 때까지 기다린다
 * (rq-11의 collectMessages와 동일 근거 — GA-17에서 60개 전송이 실제로 모두
 * 서버에 도달·브로드캐스트됐음을 확인하는 동기화 지점으로 쓴다).
 */
function waitForMessageCount(socket: ClientSocket, room: RoomName, count: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(
        new Error(`'message'(room=${room}) 이벤트 ${count}개 중 ${seen}개만 ${timeoutMs}ms 내에 도착했다`)
      );
    }, timeoutMs);
    function onMessage(payload: { room: RoomName }): void {
      if (payload.room !== room) return;
      seen += 1;
      if (seen === count) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve();
      }
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

/**
 * startServer와 동일하지만 io도 함께 반환한다 — 유예(30초, fake timer) 테스트가
 * 서버 측 소켓의 실제 'disconnect' 이벤트를 직접 관찰해야 하기 때문
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

/** 클라이언트 소켓을 접속시키고 disconnect를 cleanupFns에 등록한다. */
function connectClient(url: string, cleanupFns: Array<() => void | Promise<void>>): ClientSocket {
  const socket = ioClient(url, { forceNew: true });
  cleanupFns.push(() => {
    socket.disconnect();
  });
  return socket;
}

/** 연결된 클라이언트 소켓의 id를 안전하게 읽는다(연결 전이면 에러). */
function requireSocketId(socket: ClientSocket): string {
  if (!socket.id) {
    throw new Error('클라이언트 소켓이 아직 연결되지 않아 id가 없다');
  }
  return socket.id;
}

/**
 * 서버 측 소켓(clientSocketId와 동일 id — Socket.IO는 클라·서버 id를
 * 공유한다)이 실제로 'disconnect'를 발생시킬 때까지 기다린다. 유예(30초)
 * fake timer 테스트에서 "서버가 disconnect를 처리해 유예 타이머를 스케줄한
 * 시점"과 동기화하기 위한 헬퍼 — 이 확인 없이 곧바로 fake timer를 진행시키면
 * 서버가 아직 disconnect를 인지하기 전이라 유예 타이머 자체가 아직 생성되지
 * 않았을 수 있다(레이스).
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

/** ADR-0003 결정5: 퇴장 유예 30초. 경계값 해석은 파일 상단 주석 참고. */
const GRACE_PERIOD_MS = 30_000;

describe('RQ-18 / GA-12: 비활성 room에 도착한 메시지는 안 읽음을 증가시키고, 활성 room은 영향받지 않는다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A·room-B에 참여하고 활성 room을 room-A로 통지한 상태에서 user2가 room-B에 메시지 2개를 보내면, room-B 안 읽음이 2가 되고 활성 room인 room-A는 0을 유지한다 (RQ-18, GA-12)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      // given: user1이 세션을 얻고(identify) room-A·room-B에 참여, 활성
      // room을 room-A로 통지한다.
      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(user1, { room: 'room-B', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);

      // user2는 room-B에만 참여해 메시지를 보낸다(발신 전용 — 기존 관례와
      // 동일하게 identify를 호출하지 않는다).
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      // when: user2가 room-B에 메시지 2개 전송. 트리거 직전에 관찰자를 등록한다.
      const roomBConverges = waitForUnreadConvergence(user1, 'room-B', 2);
      const roomANeverIncrements = assertNoUnreadEventForRoom(user1, 'room-A', 300);
      user2.emit('message', { room: 'room-B', body: 'hi-1' });
      user2.emit('message', { room: 'room-B', body: 'hi-2' });

      // then: room-B 안 읽음이 2, 활성 room인 room-A는 안 읽음 이벤트가 전혀
      // 발생하지 않는다(0 유지).
      const converged = await roomBConverges;
      const expected: UnreadPayload = { room: 'room-B', count: 2 };
      expect(converged).toEqual(expected);
      await expect(roomANeverIncrements).resolves.toBeUndefined();
    }
  );
});

describe('RQ-18 / GA-13: 활성 room으로 전환하면 그 room의 안 읽음이 0으로 초기화된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-B 안 읽음이 2인 상태(활성 room은 room-A)에서 user1이 활성 room을 room-B로 통지하면 room-B 안 읽음이 0으로 초기화된다 (RQ-18, GA-13)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(user1, { room: 'room-B', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      // given: room-B 안 읽음을 2로 만든다.
      const unreadReachesTwo = waitForUnreadConvergence(user1, 'room-B', 2);
      user2.emit('message', { room: 'room-B', body: 'hi-1' });
      user2.emit('message', { room: 'room-B', body: 'hi-2' });
      await unreadReachesTwo;

      // when: user1이 활성 room을 room-B로 통지한다. 트리거 직전에 관찰자를
      // 등록해 초기화 이벤트를 놓치지 않는다.
      const unreadResets = waitForUnreadEvent(user1, 'room-B');
      const activeAck = await waitForActiveRoomAck(user1, { room: 'room-B' });
      expect(activeAck.ok).toBe(true);

      // then: room-B 안 읽음이 0으로 초기화된다.
      const resetPayload = await unreadResets;
      const expected: UnreadPayload = { room: 'room-B', count: 0 };
      expect(resetPayload).toEqual(expected);
    }
  );
});

describe('RQ-18 / GA-14: 새로고침 후 동일 세션 토큰으로 유예(30초) 내 재접속하면 참여 상태(안 읽음 포함)가 복원된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-B 안 읽음이 2인 상태에서 user1의 연결이 끊기고(새로고침 모사) 유예(30초) 이내에 동일 세션 토큰으로 새 소켓에서 재접속하면 room-B 안 읽음이 2로 복원되고, 재접속 후에도 세션이 실제로 이어져 안 읽음이 계속 누적된다 (RQ-18, GA-14)',
    async () => {
      const { url, io } = await startServerWithIo(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      const token = identifyAck.token;
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(user1, { room: 'room-B', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      // given: room-B 안 읽음을 2로 만든다.
      const unreadReachesTwo = waitForUnreadConvergence(user1, 'room-B', 2);
      user2.emit('message', { room: 'room-B', body: 'hi-1' });
      user2.emit('message', { room: 'room-B', body: 'hi-2' });
      await unreadReachesTwo;

      // when: "새로고침" — user1의 연결이 끊기고, 유예(30초) 내에 동일
      // 토큰으로 새 소켓에서 resume한다.
      const user1SocketId = requireSocketId(user1);
      vi.useFakeTimers();
      try {
        const serverObservedDisconnect = waitForServerSocketDisconnect(io, user1SocketId);
        user1.disconnect();
        await serverObservedDisconnect;
        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS - 1000); // 유예(30초) 이내

        // 시간 조작(유예 진행)은 여기서 끝난다 — 이후 재접속·resume·메시지
        // 송수신은 전부 실제 네트워크 I/O이므로 실제 타이머로 되돌린다(그대로
        // fake timer를 유지하면 아래 waitForResumeAck 등의 자체 타임아웃도
        // 함께 fake가 되어, 서버가 실제로 응답하지 않을 때 테스트가 깔끔한
        // 타임아웃 대신 무한 대기하게 된다).
        vi.useRealTimers();

        const user1Reconnected = connectClient(url, cleanupFns);
        const resumeAck = await waitForResumeAck(user1Reconnected, { token });

        // then: 참여 상태(안 읽음 포함)가 복원된다.
        if (resumeAck.ok === false) throw new Error(`resume 실패: ${resumeAck.error}`);
        expect(resumeAck.nickname).toBe('user1');
        expect(resumeAck.activeRoom).toBe('room-A');
        expect([...resumeAck.rooms].sort()).toEqual(['room-A', 'room-B', GLOBAL_ROOM].sort());
        expect(resumeAck.unread['room-B']).toBe(2);

        // 양성 대조: ack가 단순 값 조작이 아니라 세션이 실제로 복원됐다면
        // (room 재합류) 재접속 이후에도 room-B 안 읽음이 계속 누적돼야 한다.
        const unreadReachesThree = waitForUnreadConvergence(user1Reconnected, 'room-B', 3);
        user2.emit('message', { room: 'room-B', body: 'hi-3-after-resume' });
        await unreadReachesThree;
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

describe('RQ-18 / GA-15: 미참여 room의 메시지는 안 읽음 대상이 아니다 (RQ-02 격리)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A에만 참여(room-B 미참여)하고 활성 room이 room-A인 상태에서 user2가 room-B에 메시지를 보내도 user1에게 room-B 안 읽음이 생기지 않는다 (RQ-18, GA-15)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-B', nickname: 'user2' })).ok).toBe(true);

      const roomBNeverIncrements = assertNoUnreadEventForRoom(user1, 'room-B', 300);
      user2.emit('message', { room: 'room-B', body: 'hello room-B' });
      await expect(roomBNeverIncrements).resolves.toBeUndefined();
    }
  );
});

describe('RQ-18 / GA-16: global도 참여 room으로서 안 읽음 집계 대상이다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1의 활성 room이 room-A(global 자동 참여)인 상태에서 user2가 global에 메시지를 보내면 user1의 global 안 읽음이 1이 된다 (RQ-18, GA-16)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck1 = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck1.ok === false) throw new Error(`identify 실패: ${identifyAck1.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck1.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);

      // user2는 global에 발신하려면 nickname이 필요하다 — join은 예약 이름
      // 'global'을 거부하므로 identify로 nickname만 확보한다(기존 GA-27과
      // 동일 근거).
      const identifyAck2 = await waitForIdentifyAck(user2, { nickname: 'user2' });
      expect(identifyAck2.ok).toBe(true);

      const globalConverges = waitForUnreadEvent(user1, GLOBAL_ROOM);
      user2.emit('message', { room: GLOBAL_ROOM, body: 'hello global' });
      const payload = await globalConverges;
      const expected: UnreadPayload = { room: GLOBAL_ROOM, count: 1 };
      expect(payload).toEqual(expected);
    }
  );
});

describe('RQ-18 / GA-17: 안 읽음 개수는 room의 링버퍼 상한(50)을 넘지 않는다 (범위 제약 ②)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A·room-B에 참여하고 활성 room이 room-B인 상태에서 user2가 room-A에 메시지 60개를 보내면 user1의 room-A 안 읽음은 정확히 50에서 멈춘다 (RQ-18, GA-17)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(user1, { room: 'room-B', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-B' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // room-A에 대한 'unread' 이벤트 전부를 수집한다 — "어느 시점에 50을
      // 스쳤는가"가 아니라 "60개를 다 보낸 뒤 최종값이 50인가·50을 넘긴
      // 적이 없는가"를 확인하기 위함(클램프 없이 그냥 60까지 세는 버그를
      // 잡아내려면 수렴 방식 대신 전량 수집이 필요하다).
      const observedCounts: number[] = [];
      function trackUnread(payload: UnreadPayload): void {
        if (payload.room === 'room-A') observedCounts.push(payload.count);
      }
      user1.on('unread', trackUnread);

      const allMessagesArrived = waitForMessageCount(user1, 'room-A', 60, 10000);
      for (let i = 1; i <= 60; i += 1) {
        user2.emit('message', { room: 'room-A', body: `msg-${i}` });
      }
      await allMessagesArrived;

      // message와 unread는 같은 handleMessage 호출 내에서 함께 방출되므로
      // (단일 스레드 이벤트 루프, RQ-11 원자성 전제와 동일 근거) 60번째
      // message 수신 시점에는 대응하는 unread 갱신도 이미 반영돼 있어야
      // 하지만, 전송 순서와 별개 이벤트 채널이라는 여지를 위해 짧은 여유를
      // 둔다(실제 타이머 — 이 describe 블록은 fake timer를 쓰지 않는다).
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      user1.off('unread', trackUnread);

      expect(observedCounts.length).toBeGreaterThan(0);
      expect(Math.max(...observedCounts)).toBe(50); // 상한을 절대 넘지 않는다
      expect(observedCounts[observedCounts.length - 1]).toBe(50); // 최종값도 50
    },
    10000
  );
});

describe('RQ-18 / GA-18: 미참여 room을 활성 room으로 통지하면 서버가 거부하고 활성 room은 유지된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room-A에 참여하고 활성 room이 room-A인 상태에서 미참여 room-C를 활성 room으로 통지하면 서버가 거부하고, 활성 room은 여전히 room-A로 유지된다 (RQ-18, GA-18)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);
      const user2 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
      expect((await waitForActiveRoomAck(user1, { room: 'room-A' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

      // when: user1이 미참여 room-C를 활성 room으로 통지 시도.
      const rejectedAck = await waitForActiveRoomAck(user1, { room: 'room-C' });
      expect(rejectedAck.ok).toBe(false);

      // then(양성 대조): 활성 room은 여전히 room-A다 — user2가 room-A에 보낸
      // 메시지가 안 읽음으로 집계되면 안 된다(집계된다면 활성 room이 room-C로
      // 잘못 바뀌었거나 room-A가 더 이상 활성이 아니라는 뜻).
      const roomANeverIncrements = assertNoUnreadEventForRoom(user1, 'room-A', 300);
      user2.emit('message', { room: 'room-A', body: 'still active' });
      await expect(roomANeverIncrements).resolves.toBeUndefined();
    }
  );
});

describe('RQ-18 (파생, 골든 아님): identify는 서버 발급 세션 토큰을 함께 반환한다 (ADR-0003 결정1-2)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('identify에 성공하면 ack에 비어있지 않은 문자열 token이 포함되고, 서로 다른 두 소켓은 서로 다른 token을 받는다', async () => {
    const url = await startServer(cleanupFns);
    const user1 = connectClient(url, cleanupFns);
    const user2 = connectClient(url, cleanupFns);

    const ack1 = await waitForIdentifyAck(user1, { nickname: 'user1' });
    const ack2 = await waitForIdentifyAck(user2, { nickname: 'user2' });
    if (ack1.ok === false) throw new Error(`user1 identify 실패: ${ack1.error}`);
    if (ack2.ok === false) throw new Error(`user2 identify 실패: ${ack2.error}`);

    expect(typeof ack1.token).toBe('string');
    expect(ack1.token.length).toBeGreaterThan(0);
    expect(ack2.token).not.toBe(ack1.token);
  });
});

describe('RQ-18 (파생, 골든 아님): 세션 생성 직후에는 활성 room이 없어 참여 중인 모든 room이 안 읽음 집계 대상이다 (ADR-0003 결정4)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('activeRoom을 한 번도 통지하지 않은 상태에서 참여 중인 room에 메시지가 도착하면 안 읽음이 증가한다', async () => {
    const url = await startServer(cleanupFns);
    const user1 = connectClient(url, cleanupFns);
    const user2 = connectClient(url, cleanupFns);

    const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
    if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
    // activeRoom을 의도적으로 호출하지 않는다 — "첫 통지 전" 상태를 검증한다.
    expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);
    expect((await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' })).ok).toBe(true);

    const roomAIncrements = waitForUnreadEvent(user1, 'room-A');
    user2.emit('message', { room: 'room-A', body: 'no active room yet' });
    const payload = await roomAIncrements;
    const expected: UnreadPayload = { room: 'room-A', count: 1 };
    expect(payload).toEqual(expected);
  });
});

describe('RQ-18 (파생, 골든 아님): 활성 room에서 퇴장하면 활성 room은 다시 없음으로 돌아간다 (ADR-0003 결정4)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('활성 room이던 room-B를 떠난 뒤 새로 참여한 room-C에 메시지가 도착하면(activeRoom 재통지 없이도) 안 읽음이 증가한다', async () => {
    const url = await startServer(cleanupFns);
    const user1 = connectClient(url, cleanupFns);
    const user2 = connectClient(url, cleanupFns);

    const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
    if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
    expect((await waitForJoinAck(user1, { room: 'room-B', nickname: identifyAck.nickname })).ok).toBe(true);
    expect((await waitForActiveRoomAck(user1, { room: 'room-B' })).ok).toBe(true);

    // when: 활성 room(room-B)에서 퇴장한다.
    const leaveAck = await waitForLeaveAck(user1, { room: 'room-B' });
    expect(leaveAck.ok).toBe(true);

    // 새 room-C에 참여(activeRoom 재통지 없음) — 활성 room이 null로
    // 되돌아갔다면 room-C도 곧바로 집계 대상이어야 한다.
    expect((await waitForJoinAck(user1, { room: 'room-C', nickname: identifyAck.nickname })).ok).toBe(true);
    expect((await waitForJoinAck(user2, { room: 'room-C', nickname: 'user2' })).ok).toBe(true);

    const roomCIncrements = waitForUnreadEvent(user1, 'room-C');
    user2.emit('message', { room: 'room-C', body: 'active room reset to none' });
    const payload = await roomCIncrements;
    const expected: UnreadPayload = { room: 'room-C', count: 1 };
    expect(payload).toEqual(expected);
  });
});

describe('RQ-18 (파생, 골든 아님): 퇴장 유예(30초)가 만료되면 퇴장이 확정되어 세션과 안 읽음 개수가 버려진다 (ADR-0003 결정5)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    '유예(30초)를 초과한 뒤에는 동일 토큰으로도 resume이 거부된다(세션이 이미 폐기됨)',
    async () => {
      const { url, io } = await startServerWithIo(cleanupFns);
      const user1 = connectClient(url, cleanupFns);

      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      if (identifyAck.ok === false) throw new Error(`identify 실패: ${identifyAck.error}`);
      const token = identifyAck.token;
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: identifyAck.nickname })).ok).toBe(true);

      const user1SocketId = requireSocketId(user1);
      vi.useFakeTimers();
      try {
        const serverObservedDisconnect = waitForServerSocketDisconnect(io, user1SocketId);
        user1.disconnect();
        await serverObservedDisconnect;
        // 유예(30초)를 초과해 진행 — 퇴장이 확정된다.
        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS + 1);

        // 시간 조작은 여기서 끝난다 — 이후 재접속·resume 시도는 실제 네트워크
        // I/O이므로 실제 타이머로 되돌린다(그대로 두면 waitForResumeAck의
        // 자체 타임아웃도 fake가 되어, 서버가 응답하지 않을 때 깔끔한
        // 타임아웃 대신 무한 대기하게 된다).
        vi.useRealTimers();

        const user1Reconnected = connectClient(url, cleanupFns);
        const resumeAck = await waitForResumeAck(user1Reconnected, { token });
        expect(resumeAck.ok).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
    10000
  );
});
