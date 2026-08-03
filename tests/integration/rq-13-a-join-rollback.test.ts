// @vitest-environment jsdom
/**
 * RQ-13-a (specs/requirements.md §2 RQ-13):
 * "시스템은 존재하는 모든 room의 목록을 모든 사용자에게 제공해야 한다. 동일
 * 이름의 room은 동시에 둘 이상 존재할 수 없다 (이름 = 고유 식별자)." —
 * ADR-0004 결정 3이 'global'(대소문자 무관)을 예약 이름으로 정하고 서버가
 * 그 이름의 room 생성을 거부한다(src/server/chat/room.ts,
 * isReservedRoomNameForCreation). ①room·nickname이 빈 문자열, ②예약 이름,
 * 두 경로 모두 `ack({ ok: false, ... })`로 거부된다.
 *
 * ── 이 파일을 다시 쓴 이유 (리뷰 blocker B-1, ADR-0005 결정4 "실증 (2026-08-03,
 * RQ-13-a)" 문단이 정본) ──
 * 이전 `tests/client/rq-13-a-join-rollback.test.ts`는 `socket.io-client`의
 * `io()`를 **전 전송 목**으로 대체해 서버 ack 판정을 손으로 흉내 냈다. 리뷰가
 * 뮤테이션으로 증명했다 — `activeRoom` 통지를 `join`보다 먼저 내보내는 회귀(D1,
 * RQ-18 안 읽음 오류)를 코드에 되돌려 넣어도 그 목이 `activeRoom` ack을 무조건
 * `{ok:true}`로 회신하는 바람에 스위트가 50/50 초록이었다. ADR-0005 결정4의
 * "전송 계층만 대체" 조항은 **서버가 ack으로 판정하는 요청**(join·activeRoom
 * 모두 해당)에는 적용되지 않는다 — 그 판정 자체를 목이 대신 내리면 검증
 * 대상에서 통째로 빠진다. 이 파일은 실 서버(`createChatServer`)를 테스트
 * 프로세스 안에서 기동하고 실 `socket.io-client`로 접속한다. 유일한 대역은
 * `socket.io-client`의 `io()` 호출에 **테스트 서버 URL을 주입**하는 것뿐이다
 * (useChat.ts가 `io({autoConnect:true})`처럼 URL 없이 호출해 브라우저의
 * Vite 프록시에 의존하기 때문 — 테스트 프로세스엔 그 프록시가 없다) — 그
 * 외의 모든 emit/ack/이벤트는 실서버가 그대로 처리한다. 이는 evaluator가
 * RQ-13-a 2차 재평가에서 D1을 닫았음을 확인할 때 쓴 것과 같은 기법이다
 * (`_workspace/RQ-13/03_evaluator_report.md` "실제 useChat 훅을 실서버·실
 * socket.io-client로 구동했다(목은 io()에 URL을 주입하는 것뿐, 프로토콜은
 * 전부 실서버가 처리)").
 *
 * ── 골든 케이스 매핑 (evals/golden/track-a-product.jsonl, status: done — 이
 * 파일의 `verify` 필드가 가리키는 경로) ──
 * - GA-28: user1 접속(닉네임 확정) → 예약 이름('GLOBAL')으로 join이 서버까지
 *   도달해 거부(ok:false) → 클라이언트도 그 거부를 반영해 참여 room 목록·활성
 *   room·참여자 목록·메시지 패널 어디에도 그 room이 남지 않는다(GA-24가 서버
 *   축을, 이 케이스가 클라이언트 축을 덮는다).
 * - GA-29: user1이 resume 대기 중이라 본인 닉네임이 아직 확정되지 않음(빈
 *   문자열) → room-A 참여 시도 → 서버가 nickname 검사로 거부(ok:false) →
 *   GA-28과 동일한 롤백(거부 사유가 다름 — 클라이언트는 ok:false만 본다).
 * - GA-30 (대조군): user1 접속(닉네임 확정), 참여 room 목록 비어 있음 →
 *   room-A로 참여해 서버가 승인(ok:true) → 낙관적 갱신이 그대로 유지된다
 *   (이게 없으면 "항상 롤백"이 GA-28·29를 통과한다).
 *
 * ── D1 잠금 — 이 재작성의 존재 이유 ──
 * 리뷰가 잡은 결함은 "성공한 join 뒤에도 서버의 활성 room이 갱신되지 않아
 * RQ-18 안 읽음이 오작동"하는 것이었다(`activeRoom` emit이 `join` emit보다
 * 먼저 나가 서버가 미참여 room의 활성화를 거부, `src/server/chat/session.ts`
 * `handleActiveRoom`). 현재 `src/client/useChat.ts`는 이미 이를 고쳐 ack
 * 성공 분기 안에서만 `activeRoom`을 통지하지만(§코드 참고), **이 파일이
 * 그것을 실 서버로 고정하지 않으면** 다음에 누가 그 순서를 되돌려도 아무
 * 테스트도 못 잡는다(구 목은 `activeRoom` ack을 무조건 `ok:true`로
 * 회신했으므로). 아래 GA-30 테스트는 성공 join 뒤: (a) 훅이 보낸
 * `activeRoom` emit의 실제 서버 ack이 `{ok:true}`인지, (b) 보고 있는(활성)
 * room에 메시지가 와도 안 읽음이 오르지 않는지, (c) 비활성 room은 여전히
 * +1되는지(RQ-18 자체가 죽지 않았다는 대조)를 함께 잠근다.
 *
 * ── 남은 결함 고정 — 리뷰 M-2(동시 join 역순 거부) ──
 * `_workspace/review/fix-RQ-13-a-join-rollback.md` M-2: room-A join(ack 보류)
 * 도중 room-B join이 뒤이어 활성화되고, 이후 두 join이 모두(A 먼저, B 나중)
 * 거부되면, B의 `prevActiveRoom` 복원이 이미 롤백된 'A'로 activeRoom을
 * 되돌려 `rooms=[]`인데 `activeRoom='A'`를 가리키는 유령 room 상태가 된다
 * (`ChatApp`은 `activeRoom !== null`이면 Composer를 열어 유령 room으로 전송이
 * 가능해진다). 이 파일 마지막 describe가 이를 파생(골든 아님) 테스트로
 * 고정한다 — 두 join 모두 빈 nickname(GA-29와 동일 메커니즘)으로 거부시켜
 * 결정적으로 재현한다(같은 소켓의 emit 순서 = 서버 처리 순서 = ack 도착
 * 순서, Socket.IO 단일 연결의 순서 보장).
 *
 * ── 테스트 더블 경계 (ADR-0005 결정4, 위 실증 문단) ──
 * `socket.io-client`의 `io()`만 대체하되 **URL 주입 + activeRoom emit의 ack
 * 관측(기록만, 응답 조작 없음)** 두 가지 역할뿐이다. join/leave/identify/
 * resume/message/activeRoom 전부 실서버(`createChatServer`)가 실제로
 * 판정·응답한다. 모든 대기에는 상한을 명시한다(ADR-0005).
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';

/**
 * `socket.io-client`의 `io()`에 URL을 주입하고 `activeRoom` emit의 ack만
 * 관측(기록)한다. 그 외 동작은 실제 `socket.io-client`를 그대로 호출한다 —
 * ADR-0005 결정4의 "전송 계층만 대체"를 지키기 위해 프로토콜은 절대 흉내
 * 내지 않는다. `useChat.ts`는 `io({autoConnect:true})`처럼 URL 없이 호출하고
 * (브라우저 Vite 프록시 의존), 이 파일의 `connectRaw` 헬퍼는 기존
 * `tests/integration/*.test.ts` 관례대로 `io(url, {forceNew:true})`처럼
 * URL을 직접 넘긴다 — 두 호출 형태를 모두 실 서버로 연결하기 위해 첫
 * 인자가 문자열인지로 분기한다.
 */
const fake = vi.hoisted(() => {
  let url = '';
  const activeRoomAcks: unknown[] = [];
  return {
    setUrl(u: string): void {
      url = u;
    },
    getUrl(): string {
      return url;
    },
    activeRoomAcks,
  };
});

vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  function ioRedirected(...args: unknown[]) {
    const first = args[0];
    let uri: string;
    let opts: Record<string, unknown>;
    if (typeof first === 'string') {
      // connectRaw처럼 URL을 직접 넘기는 호출 — 그대로 실 서버로.
      uri = first;
      opts = (args[1] as Record<string, unknown> | undefined) ?? {};
    } else {
      // useChat.ts의 io({...})처럼 URL 없는 호출 — 이 테스트가 지정한 서버로 리다이렉트.
      uri = fake.getUrl();
      opts = (first as Record<string, unknown> | undefined) ?? {};
    }
    const socket = actual.io(uri, { ...opts, forceNew: true });
    const originalEmit = socket.emit.bind(socket);
    // D1 관측 전용 래핑 — activeRoom emit의 실제 서버 ack을 기록만 하고
    // 그대로 원래 콜백에 전달한다(응답 내용은 절대 건드리지 않는다).
    socket.emit = ((event: string, ...rest: unknown[]) => {
      if (event === 'activeRoom') {
        const payload = rest[0];
        const cb = rest[1] as ((ack: unknown) => void) | undefined;
        return originalEmit(event, payload, (ack: unknown) => {
          fake.activeRoomAcks.push(ack);
          cb?.(ack);
        });
      }
      return originalEmit(event, ...rest);
    }) as typeof socket.emit;
    return socket;
  }
  return { ...actual, io: ioRedirected };
});

const { useChat, TOKEN_KEY } = await import('../../src/client/useChat');

type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };

/** join emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). 기존 통합 테스트 관례 재사용. */
function waitForJoinAck(
  socket: ClientSocket,
  payload: { room: string; nickname: string },
  timeoutMs = 2000,
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

/** 테스트마다 독립 서버를 기동해 접속 URL을 반환하고, 이 파일의 io() 목을 그 URL로 향하게 한다. */
async function startServer(cleanupFns: Array<() => void | Promise<void>>): Promise<string> {
  const { httpServer, io } = createChatServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  cleanupFns.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
  const url = `http://localhost:${port}`;
  fake.setUrl(url);
  return url;
}

/**
 * 관찰/발신 전용 raw 클라이언트 소켓(useChat을 거치지 않음) — 기존 통합
 * 테스트의 connectClient와 동일 역할. 이 파일 상단의 `ioClient` import는
 * vi.mock이 감싼 io이지만, URL을 문자열로 직접 넘기므로 ioRedirected의 첫
 * 분기(그대로 실 서버로 전달)를 타 실질적으로 실 소켓을 만든다.
 */
function connectRaw(url: string, cleanupFns: Array<() => void | Promise<void>>): ClientSocket {
  const socket = ioClient(url, { forceNew: true });
  cleanupFns.push(() => {
    socket.disconnect();
  });
  return socket;
}

/**
 * 실 서버 ack(비동기 네트워크 I/O)이 반영될 때까지 폴링한다 — 상한 명시
 * (ADR-0005). `act()`로 감싸지 않는다: 시도해 본 결과 `act(async () => {
 * await waitFor(...) })`로 감싸면 폴링 도중 React가 리렌더를 커밋하지 않아
 * (`result.current`가 갱신되지 않은 채 멈춘다) 타임아웃까지 항상 실패했다 —
 * `@testing-library/react`의 `waitFor`는 그 자체로 이미 act 환경을 인지하고
 * 폴링마다 필요한 처리를 하므로 이중으로 감쌀 필요가 없다(기존
 * `rq-10-a-session-resume.test.tsx`도 `waitFor`를 `act()` 없이 그대로 쓴다).
 */
async function actWaitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  await waitFor(assertion, { timeout: timeoutMs });
}

/** identify 왕복이 끝나 세션 토큰이 저장됐음을(=connect+identify 완료) 확인한다. */
async function waitForIdentified(timeoutMs = 2000): Promise<void> {
  await actWaitFor(() => {
    expect(localStorage.getItem(TOKEN_KEY)).not.toBeNull();
  }, timeoutMs);
}

/** resume이 거부되어 onResumeFail이 호출됐음을(=닉네임 미확정 상태 확정) 확인한다. */
async function waitForResumeFail(onResumeFail: () => void, timeoutMs = 2000): Promise<void> {
  await actWaitFor(() => {
    expect(onResumeFail).toHaveBeenCalled();
  }, timeoutMs);
}

beforeEach(() => {
  localStorage.clear();
  fake.activeRoomAcks.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('RQ-13-a / GA-28: 예약 이름 거부 시 클라이언트가 참여 목록에 남기지 않는다 (통합 계층)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('서버가 예약 이름을 거부하면 클라이언트가 참여 목록에 그 room을 남기지 않는다 (RQ-13, GA-28)', async () => {
    await startServer(cleanupFns);

    // given: user1 접속, 닉네임 확정(identify 왕복 완료).
    const { result, unmount } = renderHook(() => useChat('user1'));
    cleanupFns.push(() => unmount());
    await waitForIdentified();

    // when: 예약 이름 'GLOBAL'로 join 시도 — 실 서버가 대소문자 무관 비교로 거부(ok:false).
    act(() => {
      result.current.joinRoom('GLOBAL');
    });

    // then: 참여 room 목록·활성 room·참여자 목록·메시지 패널 어디에도 남지 않는다.
    await actWaitFor(() => {
      expect(result.current.rooms).not.toContain('GLOBAL');
      expect(result.current.activeRoom).not.toBe('GLOBAL');
    });
    expect(result.current.participantsByRoom['GLOBAL']).toBeUndefined();
    expect(result.current.messagesByRoom['GLOBAL']).toBeUndefined();
  });
});

describe('RQ-13-a / GA-29: 빈 nickname 거부 시에도 동일하게 롤백된다 (통합 계층)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('거부 사유가 빈 nickname이어도 동일하게 롤백된다 (RQ-13, GA-29)', async () => {
    await startServer(cleanupFns);

    // given: user1이 resume 대기 중 — 실 서버가 모르는 토큰이라 resume이
    // 거부되고(ok:false), useChat(null)이라 identifyFresh는 onResumeFail만
    // 부르고 아무 identify도 하지 않는다 — 본인 닉네임은 빈 문자열로 남는다.
    localStorage.setItem(TOKEN_KEY, 'no-such-session-token');
    const onResumeFail = vi.fn();
    const { result, unmount } = renderHook(() => useChat(null, onResumeFail));
    cleanupFns.push(() => unmount());
    await waitForResumeFail(onResumeFail);
    expect(result.current.nickname).toBe('');

    // when: room-A 참여 시도 — 실 서버가 빈 nickname 검사로 거부(ok:false).
    act(() => {
      result.current.joinRoom('room-A');
    });

    // then: GA-28과 같은 결과 — 클라이언트에 room-A가 남지 않는다.
    await actWaitFor(() => {
      expect(result.current.rooms).not.toContain('room-A');
      expect(result.current.activeRoom).not.toBe('room-A');
    });
    expect(result.current.participantsByRoom['room-A']).toBeUndefined();
    expect(result.current.messagesByRoom['room-A']).toBeUndefined();
  });
});

describe('RQ-13-a / GA-30 + D1 잠금: 서버 승인 시 낙관적 갱신 유지 + 활성 room 통지가 실제로 서버에 반영된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    '서버가 승인하면 낙관적 갱신은 유지되고(GA-30), activeRoom ack이 실제로 ok:true이며 ' +
      '보고 있는 room은 안읽음이 오르지 않고 비활성 room은 오른다(RQ-13 GA-30 + RQ-18 D1 회귀 고정)',
    async () => {
      const url = await startServer(cleanupFns);

      // given: user1 접속(닉네임 확정), 참여 room 목록 비어 있음.
      const { result, unmount } = renderHook(() => useChat('user1'));
      cleanupFns.push(() => unmount());
      await waitForIdentified();

      // when: room-ok로 참여 — 실 서버가 승인(ok:true).
      act(() => {
        result.current.joinRoom('room-ok');
      });

      // then (GA-30 4축): 낙관적 갱신이 그대로 유지된다 — 무조건 롤백이면 여기서 깨진다.
      await actWaitFor(() => {
        expect(result.current.rooms).toContain('room-ok');
        expect(result.current.activeRoom).toBe('room-ok');
      });
      expect(result.current.participantsByRoom['room-ok']).toEqual(['user1']);
      expect(result.current.messagesByRoom['room-ok']).toEqual([]);

      // then (D1 — 1/3): join 성공 뒤 훅이 보낸 activeRoom emit의 실제 서버 ack이
      // ok:true다. D1이 되살아나면(activeRoom emit이 join보다 먼저 나가면)
      // 서버는 '참여하지 않은 room은 활성 room으로 설정할 수 없다'로 거부한다
      // (src/server/chat/session.ts handleActiveRoom).
      await actWaitFor(() => {
        expect(fake.activeRoomAcks.length).toBeGreaterThan(0);
      });
      expect(fake.activeRoomAcks[fake.activeRoomAcks.length - 1]).toEqual({ ok: true });

      // room-ok을 비활성으로 만들기 위해 두 번째 room에 참여한다(활성이 room-other로 이동).
      const activeRoomAcksBeforeSecond = fake.activeRoomAcks.length;
      act(() => {
        result.current.joinRoom('room-other');
      });
      await actWaitFor(() => {
        expect(result.current.activeRoom).toBe('room-other');
      });
      await actWaitFor(() => {
        expect(fake.activeRoomAcks.length).toBeGreaterThan(activeRoomAcksBeforeSecond);
      });
      expect(fake.activeRoomAcks[fake.activeRoomAcks.length - 1]).toEqual({ ok: true });

      // 관찰용 raw 소켓(user2)이 두 room에 실제로 참여해 메시지를 보낸다.
      const user2 = connectRaw(url, cleanupFns);
      expect((await waitForJoinAck(user2, { room: 'room-ok', nickname: 'user2' })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-other', nickname: 'user2' })).ok).toBe(true);

      user2.emit('message', { room: 'room-other', body: 'to-active' }); // 활성 room(D1이 되살아나면 여기서 +1)
      user2.emit('message', { room: 'room-ok', body: 'to-inactive' }); // 비활성 room(RQ-18 대조군 — 반드시 +1)

      // then (D1 — 2/3, RQ-18 대조군): 비활성 room(room-ok)은 안읽음이 오른다 —
      // RQ-18 자체가 죽지 않았음의 증거(수렴 대기).
      await actWaitFor(() => {
        expect(result.current.unreadByRoom['room-ok']).toBe(1);
      });
      // then (D1 — 3/3): 활성 room(room-other)은 안읽음이 오르지 않는다 — 위
      // room-ok 수렴을 먼저 기다려 message/unread 왕복이 끝난 뒤 최종값을 확인한다.
      expect(result.current.unreadByRoom['room-other'] ?? 0).toBe(0);
    },
  );
});

describe('RQ-13-a (파생, 골든 아님): 동시 join이 역순으로 거부되면 activeRoom이 유령 room을 가리키지 않는다 (리뷰 M-2)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  // 골든 아님 — GA-28/29/30은 join 1건만 다뤄 "여러 join이 겹칠 때 activeRoom
  // 복원이 서로 간섭하는가"를 검증하지 못한다. 리뷰(_workspace/review/
  // fix-RQ-13-a-join-rollback.md M-2)가 실제 코드에서 잡은 잔여 결함이다:
  // room-A join 도중(ack 보류) room-B join이 뒤이어 활성화되면
  // prevActiveRoom_B는 'room-A'를 스냅샷한다. A가 먼저 거부되면(activeRoom이
  // 이미 'room-B'라 A의 롤백은 activeRoom을 건드리지 않는다) rooms에서
  // room-A만 제거된다. 이어 B도 거부되면 prevActiveRoom_B('room-A')로
  // **무조건** 복원하는데, room-A는 이미 롤백돼 rooms에 없다 — rooms=[]인데
  // activeRoom='room-A'를 가리키는 유령 상태가 된다(ChatApp은
  // activeRoom!==null이면 Composer를 열어 유령 room으로 전송이 가능해진다).
  // 두 join 모두 빈 nickname(GA-29와 동일 메커니즘)으로 거부시켜 결정적으로
  // 재현한다 — 같은 소켓의 emit 순서가 서버 처리 순서·ack 도착 순서와
  // 일치한다(Socket.IO 단일 연결의 순서 보장, 서버 핸들러도 동기적으로 ack).
  it(
    '선행 join(A) 도중 후행 join(B)이 활성화된 뒤 A→B 순으로 둘 다 거부되면, ' +
      '롤백 후 activeRoom은 rooms에 없는 room을 가리키지 않는다 (RQ-13-a 파생, 리뷰 M-2)',
    async () => {
      await startServer(cleanupFns);

      // given: 닉네임 미확정(빈 문자열) — 이후 모든 join이 서버에서 거부된다.
      localStorage.setItem(TOKEN_KEY, 'no-such-session-token');
      const onResumeFail = vi.fn();
      const { result, unmount } = renderHook(() => useChat(null, onResumeFail));
      cleanupFns.push(() => unmount());
      await waitForResumeFail(onResumeFail);
      expect(result.current.nickname).toBe('');

      // when: room-A join 직후(ack 도착 전, 같은 동기 구간에서) room-B join을
      // 이어 보낸다 — 낙관적으로 activeRoom은 'room-A' → 'room-B' 순으로 전환된다.
      act(() => {
        result.current.joinRoom('room-A');
        result.current.joinRoom('room-B');
      });

      // then: 두 거부가 모두 처리되면 참여 목록은 비어야 하고, activeRoom도
      // 그 빈 목록에 없는 room을 가리키면 안 된다 — null로 돌아가야 한다.
      await actWaitFor(() => {
        expect(result.current.rooms).toEqual([]);
      });
      expect(result.current.activeRoom).toBeNull();
    },
  );
});
