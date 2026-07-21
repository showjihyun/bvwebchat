import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM, type RoomName, type ChatMessage } from '../../src/shared/types';

/**
 * RQ-12 (specs/requirements.md §2):
 * "사용자가 새 이름으로 room 생성을 요청하면, 시스템은 권한 제한 없이 room을
 * 생성해야 한다. 마지막 참여자가 room을 떠나면, 시스템은 해당 room을 자동
 * 삭제해야 한다."
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-12):
 *   GA-25
 *     given : 닉네임만 가진 user1 (계정·역할·특별 권한 없음)
 *     when  : 존재하지 않는 새 이름 room-new로 생성(참여) 요청
 *     then  : 권한 검사 없이 room-new 생성·참여 성공, 즉시 메시지 송수신
 *             가능 (권한 제한 없는 자유 생성)
 *     verify: integration_test
 *   GA-26
 *     given : room-A에 user1만 참여하고 메시지 3개 전송(히스토리 존재)
 *     when  : user1이 room-A를 떠남(마지막 참여자 이탈)
 *     then  : room-A 서버 상태 자동 삭제 — 이후 user2가 room-A에 새로 참여
 *             하면 히스토리가 비어 있음(삭제 전 메시지·상태 소실), 새 room
 *             으로 시작. RQ-13의 목록 제외를 넘어 실제 상태 삭제.
 *     verify: integration_test
 *   GA-27
 *     given : user1만 접속(global 자동 참여), global에 메시지 전송
 *     when  : user1이 접속 종료 → 서버 활성 소켓 0 (global 멤버 0명)
 *     then  : global은 auto-delete 대상에서 제외되어 존속 — 이후 user2 접속
 *             시 rooms 목록 [global] 유지·global 메시지 브로드캐스트 정상
 *             (ADR-0004 예외 2)
 *     verify: integration_test
 *
 * ── 기존 인프라 (이미 구현·머지됨 — 이 파일은 그대로 재사용한다) ──
 * src/server/createChatServer.ts:
 *   join({room,nickname}, ack) — RQ-01/11. 성공 시 ack `{ok:true, history:
 *     ChatMessage[]}`(해당 room의 최근 50개 히스토리, 오래된 것 → 최신 순).
 *     room이 대소문자 무관 'global'이면 거부(ADR-0004 결정 3, RQ-13).
 *   message({room,body}) — RQ-02/04/11. 발신 소켓이 room 멤버가 아니면 침묵
 *     거부. 성공 시 room 멤버 전원(발신자 포함, echo)에게 브로드캐스트하고
 *     `roomHistories`(room당 최근 50개 링버퍼)에 저장.
 *   leave({room}, ack) — RQ-03/15. ack `{ok:true}|{ok:false,error}`.
 *     GLOBAL_ROOM은 탈퇴 거부(ADR-0004 결정 1). 성공 시 `roomMembers`에서
 *     이 소켓을 제거하고 참여자 목록을 남은 멤버에게 방송하며, 멤버가
 *     0명이 되면(1→0 전이) 존재 room 목록('rooms')도 전 접속자에게
 *     방송한다(RQ-13). **roomHistories는 건드리지 않는다** — 이 파일 GA-26이
 *     지적하는 결함(빈 room이 돼도 히스토리 엔트리가 남는다).
 *   identify({nickname}, ack) — RQ-10. ack `{ok:true, nickname}|{ok:false,
 *     error}`. join과 달리 어떤 room에도 참여시키지 않고 socket.data.nickname
 *     만 설정한다 — "global만 자동 참여, user room 없음" 상태에서 발신용
 *     nickname을 확보하는 유일한 수단(GA-27이 이를 이용한다).
 *   접속(connection) 시 모든 소켓은 GLOBAL_ROOM에 자동 참여하고(ADR-0004
 *     결정 1), 그 순간의 존재 room 목록 스냅샷을 유니캐스트로 즉시 받는다
 *     (RQ-13 신설 계약 2-b). disconnect 시 이 소켓이 멤버였던 각 room의
 *     참여자 목록을 갱신 방송하고, 멤버가 0이 된 room이 있으면(1→0 전이)
 *     존재 room 목록도 방송한다(RQ-13, handleDisconnect).
 *   `roomHistories: Map<RoomName, ChatMessage[]>`(RQ-11), `roomMembers:
 *     Map<RoomName, string[]>`(RQ-15) — 둘 다 **마지막 멤버가 leave/disconnect
 *     해도 키 자체는 지워지지 않고 남는다**(RQ-11 히스토리 잔존, RQ-15
 *     minor-3 빈 배열 잔존). GLOBAL_ROOM은 애초에 roomMembers에 등록되지
 *     않는다(RQ-15 설계 결정, RoomMembers 타입 주석 참고) — 이 사실이
 *     GA-27("global은 예외")의 구조적 근거다.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다, 아직 미구현, coder의 구현
 *    대상) ──
 *
 * RQ-12는 새로운 이벤트·payload shape을 추가하지 않는다 — 기존 join의
 * "권한 검사 없음"은 이미 참이고(GA-25가 이를 회귀 방지로 핀 고정), 신설이
 * 필요한 것은 오직 **삭제 로직**이다:
 *
 * 1) room이 빈 상태가 되는 시점(마지막 멤버가 leave 또는 disconnect —
 *    handleLeave/handleDisconnect가 이미 판정하는 "멤버 0명 전이" 분기와
 *    동일 시점)에 `roomHistories`와 `roomMembers`에서 그 room의 엔트리를
 *    **완전히 삭제**(`.delete(room)`)한다 — 빈 배열/빈 이력을 남겨두는 것이
 *    아니라 Map에서 키 자체를 지운다. 이후 같은 이름으로 다시 join하면
 *    "새 room"으로 취급되어야 한다(히스토리 빈 배열, 멤버 순서 처음부터).
 * 2) **GLOBAL_ROOM은 이 삭제 대상에서 완전히 제외**한다(ADR-0004 예외 2).
 *    이미 `roomMembers`가 GLOBAL_ROOM을 추적하지 않으므로(RQ-15 설계
 *    결정), "멤버 0명 전이" 분기 자체가 GLOBAL_ROOM에는 적용되지 않는다 —
 *    별도 예외 처리를 추가하지 않아도(roomMembers 기반으로만 순회) 이
 *    보호가 자동으로 성립한다. coder가 삭제 로직을 다른 자료구조(예: 전체
 *    소켓 수)를 기준으로 짜면 이 보호가 깨질 수 있으므로, GA-27은 그
 *    회귀를 잡는 가드다.
 * 3) 자유 생성(GA-25) 자체는 이미 구현돼 있다 — handleJoin이 어떤 nickname/
 *    role 검사도 하지 않고 예약 이름(global)만 거부한다. 이 파일의 GA-25
 *    테스트는 그 기존 동작을 회귀 방지 목적으로 고정(pin)한다 — coder가
 *    "자유 생성" 자체를 위해 별도 코드를 추가할 필요는 없다.
 *
 * ── 스코프 경계 (질문 아님 — 이 세션의 설계 결정 및 task 지시) ──
 * - RQ-13 minor-2(예약 이름 trim 정규화, 예: `' global '`)는 team-lead가
 *   "함께 검토"로 열어 둔 별도 항목이며 GA-25/26/27 어디에도 등장하지
 *   않는다 — 이 파일은 강제하지 않는다.
 * - global 히스토리 재생(connect 시점)은 RQ-11 파일이 이미 "미구현·이
 *   세션 강제하지 않음"으로 열어 둔 경계다 — GA-27은 이 파일에서도 여전히
 *   히스토리가 아니라 rooms 목록·브로드캐스트 동작으로만 검증한다.
 * - RQ-14(순서 보장)·RQ-18(안 읽음 개수)은 이 RQ의 스코프가 아니다.
 * - GA-26은 "leave" 경로만 명시한다. "disconnect도 마지막 참여자 이탈"
 *   이라는 동일 원리를 별도 describe 블록(골든 아님, 파생)으로 추가
 *   커버한다 — 골든 매핑표에는 포함하지 않는다(RQ-15 GA-20이 leave·
 *   disconnect 두 경로를 같은 골든으로 묶었던 것과 달리, GA-26은 leave만
 *   명시하므로 disconnect 커버리지는 이 세션이 파생으로 추가한다).
 *
 * ── RQ-18 정합 (2026-07-21, team-lead 지시) — disconnect 파생 테스트만 변경 ──
 * ADR-0003 결정5(RQ-18 스코프)는 "연결 종료 시 즉시 퇴장 처리하지 않고 30초
 * 유예를 둔다"를 세션 유무와 무관하게 모든 socket disconnect에 적용한다.
 * 바로 위 "disconnect도 동일한 삭제를 트리거해야 한다"는 파생 테스트는 원래
 * disconnect 직후 즉시 삭제(빈 히스토리)를 기대했으나, 이는 결정5와
 * 충돌한다. **단언(room-A 상태가 결국 삭제된다)은 그대로 두고, 타이밍만
 * "즉시" → "유예(30초) 경과 후"로 교정**했다(vi.useFakeTimers +
 * vi.advanceTimersByTimeAsync, ADR-0005 결정4). GA-26 본체(leave 경로,
 * 바로 위 describe 블록)는 leave가 유예 대상이 아니므로 변경하지 않았다.
 * 상세는 _workspace/RQ-18/01_test-writer_red.md 참고.
 *
 * 부정 단언 공통 원칙(ADR-0005): 이 파일은 "수신하지 않는다"류 부정 단언을
 * 쓰지 않는다 — 모든 GA가 "수신함"·"삭제됨(=재입장 시 빈 히스토리)"류
 * 양성 단언으로 검증 가능하다. 모든 비동기 대기는 상한(timeout)을
 * 명시한다.
 */

/** RQ-11 계약 재사용 — join ack는 history를 포함한다(파일 상단 주석 참고). */
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

/** RQ-10 계약 재사용 — identify는 고유화된 nickname을 ack로 반환한다. */
type IdentifyAck = { ok: true; nickname: string } | { ok: false; error: string };

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

/** RQ-13 계약 재사용 — 서버→클라이언트 'rooms' payload. */
interface RoomsPayload {
  rooms: RoomName[];
}

/** 'rooms' 이벤트를 timeoutMs 내에 기다린다(최초 1건, `once`). */
function waitForRoomsEvent(socket: ClientSocket, timeoutMs = 2000): Promise<RoomsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'rooms' 이벤트가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.once('rooms', (payload: RoomsPayload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * 지속 리스너로 'rooms' 이벤트를 모두 수집하다가, 기대값과 정확히 일치하는
 * 이벤트가 도착하면 resolve한다(tests/integration/rq-13-room-list.test.ts의
 * 동일 헬퍼와 같은 근거 — connect-time 스냅샷처럼 기대값과 다른 중간값을
 * `once`가 잘못 소비해버리는 경합을 피한다). 이 파일에서는 "disconnect로
 * room-A가 비워짐" 신호를 기다리는 파생(골든 아님) 테스트의 동기화 지점
 * 으로만 쓴다 — RQ-12 자체의 신설 계약이 아니라 이미 구현된 RQ-13 'rooms'
 * 방송을 재사용하는 관측 수단이다.
 */
function waitForRoomsConvergence(
  socket: ClientSocket,
  expected: RoomsPayload,
  timeoutMs = 2000
): Promise<RoomsPayload> {
  return new Promise((resolve, reject) => {
    const received: RoomsPayload[] = [];
    const timer = setTimeout(() => {
      socket.off('rooms', onRooms);
      reject(
        new Error(
          `'rooms' 이벤트가 ${timeoutMs}ms 내에 기대값 ${JSON.stringify(expected.rooms)}으로 수렴하지 ` +
            `않았다 (수신 이력: ${JSON.stringify(received.map((r) => r.rooms))})`
        )
      );
    }, timeoutMs);
    function onRooms(payload: RoomsPayload): void {
      received.push(payload);
      if (JSON.stringify(payload.rooms) === JSON.stringify(expected.rooms)) {
        clearTimeout(timer);
        socket.off('rooms', onRooms);
        resolve(payload);
      }
    }
    socket.on('rooms', onRooms);
  });
}

/**
 * waitForRoomsConvergence의 부정 버전 — notExpected 값으로 수렴하는 'rooms'
 * 이벤트가 timeoutMs 내에 절대 도착하지 않아야 함을 확인한다(RQ-18 정합,
 * 파일 상단 주석 참고: "즉시 처리되지 않는다"를 직접 확인하는 부정 단언 —
 * 이게 없으면 유예를 전혀 구현하지 않아도 이 테스트가 우연히 통과해버린다).
 */
function assertRoomsNeverConvergeTo(
  socket: ClientSocket,
  notExpected: RoomsPayload,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('rooms', onRooms);
      resolve();
    }, timeoutMs);
    function onRooms(payload: RoomsPayload): void {
      if (JSON.stringify(payload.rooms) === JSON.stringify(notExpected.rooms)) {
        clearTimeout(timer);
        socket.off('rooms', onRooms);
        reject(
          new Error(`'rooms' 이벤트가 ${JSON.stringify(notExpected.rooms)}로 ${timeoutMs}ms 이내에 너무 일찍 수렴했다`)
        );
      }
    }
    socket.on('rooms', onRooms);
  });
}

/**
 * 서버의 활성 소켓 수가 expected에 도달할 때까지 폴링한다 — 클라이언트의
 * `disconnect()` 호출은 로컬에서 즉시 처리되지만 서버가 그 종료를 실제로
 * 인지하는 시점은 별도의 네트워크 이벤트라 즉시 알 수 없다(GA-27의 "서버
 * 활성 소켓 0"을 직접 확인하기 위한 폴링 — 상한 명시, ADR-0005).
 */
function waitForActiveSocketCount(
  io: ReturnType<typeof createChatServer>['io'],
  expected: number,
  timeoutMs = 2000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (io.sockets.sockets.size === expected) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            `활성 소켓 수가 ${timeoutMs}ms 내에 ${expected}에 도달하지 않았다(현재 ${io.sockets.sockets.size})`
          )
        );
        return;
      }
      setTimeout(check, 20);
    };
    check();
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

/** 연결된 클라이언트 소켓의 id를 안전하게 읽는다(연결 전이면 에러) — RQ-18 정합(파일 상단 주석 참고). */
function requireSocketId(socket: ClientSocket): string {
  if (!socket.id) {
    throw new Error('클라이언트 소켓이 아직 연결되지 않아 id가 없다');
  }
  return socket.id;
}

/**
 * 서버 측 소켓(clientSocketId와 동일 id)이 실제로 'disconnect'를 발생시킬
 * 때까지 기다린다. 유예(30초, ADR-0003 결정5) fake timer를 진행시키기 전에,
 * 서버가 이 disconnect를 인지해 유예 타이머를 실제로 스케줄한 시점과
 * 동기화하기 위한 헬퍼다(RQ-18 rq-18-unread.test.ts와 동일 헬퍼, RQ-18 정합).
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

describe('RQ-12 / GA-25: 권한 제한 없이 새 이름의 room을 자유롭게 생성·참여하고 즉시 사용할 수 있다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    "닉네임만 가진 user1이 identify(계정·역할 절차) 없이 곧바로 존재하지 않는 새 이름 room-new로 join하면 권한 검사 없이 성공하고, 그 room에서 즉시 메시지를 송수신할 수 있다 (RQ-12, GA-25)",
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);

      // given: 닉네임만 가진 user1 (계정·역할·특별 권한 없음). identify
      // (RQ-10)를 의도적으로 호출하지 않는다 — 사전 등록·역할 부여 같은
      // 절차 없이 join 시점에 임의의 nickname 문자열만 제공해도 되는지를
      // 이 부재 자체로 증명한다("권한 검사 없음"의 직접 증거).

      // when: 존재하지 않는 새 이름 room-new로 생성(참여) 요청.
      const joinAck = await waitForJoinAck(user1, { room: 'room-new', nickname: 'user1' });

      // then: 권한 검사 없이 성공(ok:true). 방금 생성된 room이므로 히스토리는
      // 비어 있다(RQ-11 계약 재사용 — "새 room"의 자연스러운 초기 상태이지,
      // GA-26의 "삭제 후 재생성"과는 다른 경로다).
      if (joinAck.ok === false) {
        throw new Error(`join 실패: ${joinAck.error}`);
      }
      expect(joinAck.history).toEqual([]);

      // then: 즉시 메시지 송수신 가능 — room-new에서 보낸 메시지를 스스로
      // 수신한다(io.to(room)은 발신자도 포함 — 기존 RQ-01/03/04 테스트와
      // 동일 근거). 이 room의 유일한 멤버인 user1 자신의 echo로 송신·수신
      // 둘 다 정상 동작함을 한 번에 증명한다.
      const echo = waitForEvent<ChatMessage>(user1, 'message');
      user1.emit('message', { room: 'room-new', body: 'hello room-new' });
      const expected: ChatMessage = { room: 'room-new', nickname: 'user1', body: 'hello room-new' };
      await expect(echo).resolves.toEqual(expected);
    }
  );
});

describe('RQ-12 / GA-26: room의 마지막 참여자가 떠나면 서버 상태(히스토리 포함)가 실제로 삭제된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'room-A에 user1만 참여해 메시지 3개를 보낸 뒤 user1이 room-A를 떠나면(마지막 참여자 이탈), room-A의 서버 상태가 삭제되어 이후 참여하는 user2는 빈 히스토리로 시작한다 (RQ-12, GA-26)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns);

      // given: room-A에 user1만 참여하고 메시지 3개 전송(히스토리 존재).
      // 각 전송을 자기 자신에게 온 echo로 확인해 "정말로 저장됐다"를
      // 순차적으로 확정한다(RQ-11 링버퍼 저장 로직 재사용 — rq-11 테스트와
      // 동일 근거).
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      for (let i = 1; i <= 3; i += 1) {
        const echo = waitForEvent<ChatMessage>(user1, 'message');
        user1.emit('message', { room: 'room-A', body: `msg-${i}` });
        const expected: ChatMessage = { room: 'room-A', nickname: 'user1', body: `msg-${i}` };
        await expect(echo).resolves.toEqual(expected);
      }

      // when: user1이 room-A를 떠남(마지막 참여자 이탈). ack로 서버가 leave를
      // 실제로 처리한 시점과 동기화한다(rq-03/rq-13과 동일 근거 — leave
      // emit과 이후 user2의 join emit이 서로 다른 소켓이라 ack 없이
      // 진행하면 레이스가 생길 수 있다).
      const leaveAck = await waitForLeaveAck(user1, { room: 'room-A' });
      expect(leaveAck.ok).toBe(true);

      // then: room-A 서버 상태가 자동 삭제된다 — 이후 user2가 room-A에
      // 새로 참여하면 히스토리가 비어 있어야 한다(삭제 전 메시지 3개
      // 소실, 새 room으로 시작). 현재 구현은 handleLeave가 roomHistories를
      // 건드리지 않으므로(파일 상단 주석 참고) 이 단언은 msg-1~3이 그대로
      // 남아 있는 현재 동작에서 실패해야 정당한 Red다.
      const user2 = connectClient(url, cleanupFns);
      const joinAck2 = await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' });
      if (joinAck2.ok === false) {
        throw new Error(`join 실패: ${joinAck2.error}`);
      }
      expect(joinAck2.history).toEqual([]);
    }
  );
});

describe('RQ-12 (파생, 골든 아님): 마지막 참여자의 연결 종료(disconnect)도 leave와 동일하게 room 상태를 삭제한다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-26은 명시적 leave 경로만 다룬다. "마지막 참여자 이탈"은
  // RQ-15 GA-20이 leave·disconnect 두 경로를 같은 골든으로 묶었던 것과 같은
  // 정신으로, disconnect도 동일한 삭제를 트리거해야 함을 이 세션이 파생으로
  // 추가 커버한다(task 지시 — "원하면 leave와 disconnect 둘 다 커버").
  it(
    'room-A에 user1만 참여해 메시지 3개를 보낸 뒤 user1의 연결이 끊기면(disconnect, 마지막 참여자 이탈), 퇴장 유예(30초, ADR-0003 결정5) 경과 후 room-A의 서버 상태가 삭제되어 이후 참여하는 user2는 빈 히스토리로 시작한다 (RQ-12 파생, 골든 아님 — RQ-18 정합, 파일 상단 주석 참고)',
    async () => {
      const { httpServer, io } = createChatServer();
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const port = (httpServer.address() as AddressInfo).port;
      const url = `http://localhost:${port}`;
      cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));

      const user1 = connectClient(url, cleanupFns);

      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: 'user1' })).ok).toBe(true);
      for (let i = 1; i <= 3; i += 1) {
        const echo = waitForEvent<ChatMessage>(user1, 'message');
        user1.emit('message', { room: 'room-A', body: `msg-${i}` });
        const expected: ChatMessage = { room: 'room-A', nickname: 'user1', body: `msg-${i}` };
        await expect(echo).resolves.toEqual(expected);
      }

      // user2를 room-A가 이미 존재하는 상태(given 완료 후)에 접속시켜, 그
      // 초기 'rooms' 스냅샷이 [global, room-A]가 되게 한다 — 이후 disconnect가
      // 트리거하는 "room-A 제거"([global]) 방송과 값이 달라
      // waitForRoomsConvergence가 초기 스냅샷을 오인 소비하지 않는다
      // (rq-13-room-list.test.ts의 동일 경합 회피 기법).
      const user2 = connectClient(url, cleanupFns);
      // user2의 접속 핸드셰이크가 완전히 끝난 뒤에만 fake timer를 켠다 —
      // 핸드셰이크가 아직 진행 중일 때 fake timer가 활성화되면 그 완료가
      // 무기한 지연될 위험이 있다(RQ-18 정합 작업 중 실측된 문제). 초기
      // 'rooms' 스냅샷을 실제로 수신함으로써 접속 완료를 확인한다.
      const initialSnapshot = await waitForRoomsEvent(user2);
      const expectedInitialSnapshot: RoomsPayload = { rooms: [GLOBAL_ROOM, 'room-A'] };
      expect(initialSnapshot).toEqual(expectedInitialSnapshot);

      // "즉시 처리되지 않는다"를 직접 확인하는 부정 단언 — 이게 없으면 유예를
      // 전혀 구현하지 않아도(기존처럼 즉시 삭제해도) 이 테스트가 우연히
      // 통과해버린다(RQ-18 정합, 파일 상단 주석 참고).
      const roomANeverRemovedEarly = assertRoomsNeverConvergeTo(user2, { rooms: [GLOBAL_ROOM] }, 1000);
      // 아래에서 fake timer로 30초+α를 진행시키는 동안 자체 타임아웃이 먼저
      // 발동해 거짓 실패하지 않도록 유예보다 넉넉히 크게 잡는다.
      const roomARemovedEventually = waitForRoomsConvergence(user2, { rooms: [GLOBAL_ROOM] }, 35000);
      // Red 상태에서는 위 부정 단언이 (아래에서 실제로 await하기 전에) 이미
      // reject할 수 있다 — Node의 unhandledRejection 경고를 막기 위해 즉시
      // no-op catch를 붙여둔다(원본 promise 참조는 그대로 두어 아래에서 실제
      // 결과를 검증한다).
      roomANeverRemovedEarly.catch(() => {});

      // when: user1의 연결이 강제 종료된다(leave 이벤트 없이 소켓이 끊김,
      // 마지막 참여자 이탈). ADR-0003 결정5(RQ-18 스코프): 연결 종료는 즉시
      // 퇴장 처리되지 않고 30초 유예를 둔다 — fake timer로 유예를 진행시켜야
      // room-A 삭제(=빈 room 확정)가 트리거된다. 서버가 disconnect를 실제로
      // 인지한(유예 타이머를 스케줄한) 시점과 동기화한 뒤에만 fake timer를
      // 진행시킨다(레이스 방지).
      const user1SocketId = requireSocketId(user1);
      vi.useFakeTimers();
      try {
        const serverObservedDisconnect = waitForServerSocketDisconnect(io, user1SocketId);
        user1.disconnect();
        await serverObservedDisconnect;

        // 유예 초반(1초 시점)에는 아직 즉시 삭제되지 않아야 한다.
        await vi.advanceTimersByTimeAsync(1000);
        await expect(roomANeverRemovedEarly).resolves.toBeUndefined();

        // 남은 유예를 마저 진행시켜 30초를 넘긴다. 서버가 유예 만료로 퇴장을
        // 확정해 room-A가 roomMembers에서 비워지면(RQ-13 handleDisconnect/
        // 삭제 로직이 이 시점에 'rooms' 방송을 트리거한다) 그 방송이
        // [global]로 수렴할 때까지 기다려 "서버가 이 삭제 처리를 완전히
        // 끝냈다"는 동기화 지점으로 삼는다.
        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS - 1000 + 1);
        await roomARemovedEventually;
      } finally {
        vi.useRealTimers();
      }

      // then: room-A 서버 상태가 삭제되어 user2가 재참여 시 빈 히스토리로
      // 시작해야 한다.
      const joinAck2 = await waitForJoinAck(user2, { room: 'room-A', nickname: 'user2' });
      if (joinAck2.ok === false) {
        throw new Error(`join 실패: ${joinAck2.error}`);
      }
      expect(joinAck2.history).toEqual([]);
    },
    10000
  );
});

describe('RQ-12 / GA-27: global은 전원 접속 종료 후에도 auto-delete 예외로 존속한다 (ADR-0004 예외 2)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1만 접속(global 자동 참여)해 global에 메시지를 보낸 뒤 접속을 종료해 서버 활성 소켓이 0이 되어도, global은 삭제되지 않고 존속해 이후 접속한 user2가 rooms 목록 [global] 유지와 global 메시지 브로드캐스트를 정상 수신한다 (RQ-12, GA-27)',
    async () => {
      // io를 직접 조회(활성 소켓 수 확인)해야 하므로 이 테스트만
      // startServer 헬퍼 대신 인라인으로 서버를 기동한다.
      const { httpServer, io } = createChatServer();
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const port = (httpServer.address() as AddressInfo).port;
      const url = `http://localhost:${port}`;
      cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));

      const user1 = connectClient(url, cleanupFns);

      // given: user1만 접속(global 자동 참여). identify(RQ-10)로 발신용
      // nickname만 확보한다 — join을 쓰지 않아 user room을 전혀 만들지
      // 않는다("global만 존재, user room 없음" 상태를 정확히 대표하기
      // 위함 — join을 쓰면 그 room도 roomMembers에 등록돼 이 테스트의
      // 전제가 무너진다).
      const identifyAck = await waitForIdentifyAck(user1, { nickname: 'user1' });
      expect(identifyAck.ok).toBe(true);

      // given: global에 메시지 전송(자기 자신에게 온 echo로 확인).
      const echoBeforeDisconnect = waitForEvent<ChatMessage>(user1, 'message');
      user1.emit('message', { room: GLOBAL_ROOM, body: 'hello before disconnect' });
      const expectedBefore: ChatMessage = { room: GLOBAL_ROOM, nickname: 'user1', body: 'hello before disconnect' };
      await expect(echoBeforeDisconnect).resolves.toEqual(expectedBefore);

      // when: user1이 접속 종료 → 서버 활성 소켓 0 (global 멤버 0명).
      // 클라이언트의 disconnect() 호출은 로컬에서 즉시 처리되지만 서버가
      // 그 종료를 실제로 인지하는 시점은 별도의 비동기 이벤트이므로,
      // io.sockets.sockets.size로 서버가 실제로 "활성 소켓 0"에 도달했음을
      // 직접 확인한 뒤에 다음 단계로 진행한다(상한 명시 폴링 — ADR-0005).
      user1.disconnect();
      await waitForActiveSocketCount(io, 0);

      // then: global은 auto-delete 대상에서 제외되어 존속 — 이후 접속하는
      // user2가 rooms 목록 [global] 유지를 즉시(connect-time 스냅샷,
      // RQ-13 신설 계약 2-b) 수신한다.
      const user2 = connectClient(url, cleanupFns);
      const initialRooms = await waitForRoomsEvent(user2);
      const expectedRooms: RoomsPayload = { rooms: [GLOBAL_ROOM] };
      expect(initialRooms).toEqual(expectedRooms);

      // then: global 메시지 브로드캐스트도 정상 — user2가 identify로
      // nickname을 확보해 global에 전송하면 스스로 echo를 수신한다.
      const identifyAck2 = await waitForIdentifyAck(user2, { nickname: 'user2' });
      expect(identifyAck2.ok).toBe(true);

      const echoAfterReconnect = waitForEvent<ChatMessage>(user2, 'message');
      user2.emit('message', { room: GLOBAL_ROOM, body: 'hello after reconnect' });
      const expectedAfter: ChatMessage = { room: GLOBAL_ROOM, nickname: 'user2', body: 'hello after reconnect' };
      await expect(echoAfterReconnect).resolves.toEqual(expectedAfter);
    }
  );
});
