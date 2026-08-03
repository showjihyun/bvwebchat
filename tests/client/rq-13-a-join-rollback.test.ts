// @vitest-environment jsdom
/**
 * RQ-13-a (specs/requirements.md §2 RQ-13):
 * "시스템은 존재하는 모든 room의 목록을 모든 사용자에게 제공해야 한다. 동일
 * 이름의 room은 동시에 둘 이상 존재할 수 없다 (이름 = 고유 식별자)." —
 * ADR-0004 결정 3이 'global'(대소문자 무관)을 예약 이름으로 정하고 서버가
 * 그 이름의 room 생성을 거부한다(src/server/chat/room.ts:39-42,
 * isReservedRoomNameForCreation). ①room·nickname이 빈 문자열/비문자열,
 * ②예약 이름, 두 경로 모두 `ack({ ok: false, ... })`로 거부된다.
 *
 * ── 결함 (src/client/useChat.ts:237-251 joinRoom) ──
 * `socket?.emit('join', ..., (result) => { if (!result.ok) return; ...})`는
 * 거부를 삼킬 뿐 아무것도 되돌리지 않는다. 그 아래
 * `roomsRef.current = [...roomsRef.current, name]`부터 이어지는 낙관적 갱신
 * (참여 목록·활성 room·메시지 패널 seed·참여자 seed)은 ack 콜백 **밖**에 있어
 * 서버 응답(ok:false)과 무관하게 무조건 실행된다. 결과: 서버가 거부했는데
 * 클라이언트에는 참여에 성공한 room이 남는다.
 *
 * ── 골든 케이스 매핑 (evals/golden/track-a-product.jsonl) ──
 * - GA-28: 예약 이름('GLOBAL')으로 거부 → 클라이언트 어디에도 그 room이
 *   남지 않아야 한다(GA-24가 서버 축 — 별도 room 미생성·목록 불변 — 을 덮고
 *   이 케이스가 클라이언트 축을 덮는다).
 * - GA-29: 거부 사유가 다름(예약 이름이 아니라 빈 nickname 검사) — 롤백은
 *   동일해야 한다(클라이언트는 ok:false만 본다, 사유를 구분하지 않는다).
 * - GA-30 (대조군): 서버가 승인(ok:true)하면 낙관적 갱신이 그대로 유지되어야
 *   한다 — 이게 없으면 "무조건 롤백"이라는 틀린 구현이 GA-28·29를 통과한다.
 *
 * ── 왜 useChat을 직접 렌더링하는가(전체 <App/> 대신) ──
 * `src/client/components/JoinRoomModal.tsx:30-35`가 이미 클라이언트 레벨의
 * 예약 이름 방어를 갖고 있다 (`name.toLowerCase() === 'global'`이면
 * `canJoin=false`로 제출 자체를 막는다). 이 방어 때문에 실제 렌더된 모달 폼에
 * 'GLOBAL'을 입력해 제출하는 경로로는 `chat.joinRoom`이 아예 호출되지 않아
 * GA-28이 검증하려는 useChat의 ack 처리 결함을 통과시키지 못한다(모달이
 * 서버까지 가기 전에 막아버림). 이 결함은 useChat.ts 자체에 있으므로,
 * `@testing-library/react`의 `renderHook`으로 훅을 직접 구동해 그 반환값
 * (rooms/activeRoom/participantsByRoom/messagesByRoom)을 검증한다.
 *
 * ── 테스트 더블 경계 (ADR-0005 결정4: 전송 계층만 대체) ──
 * `socket.io-client`의 `io()` 팩토리만 목으로 대체한다(tests/client의
 * 기존 관례, rq-10-a-session-resume.test.tsx와 동일 패턴). 서버 프로토콜
 * (join/identify/resume ack shape)은 room.ts·session.ts의 실제 계약을
 * 그대로 흉내 낸다 — 새 이벤트를 창작하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };
type Handler = (payload?: unknown) => void;

/**
 * `socket.io-client`의 `io()`를 대체하는 최소 목. useChat.ts가 실제로 쓰는
 * 표면(`on`/`off`/`emit`/`close`/`io.on`)만 구현한다. `join`의 ack는 테스트가
 * 지정한 응답(getJoinResponse)을 동기 호출한다 — 실제로는 비동기지만, 순서
 * (요청→ack)만 보존하면 되는 클라이언트 배선 테스트이므로 fake timer 없이
 * 동기 처리한다(rq-10-a-session-resume.test.tsx와 동일 방침).
 * `resume`은 의도적으로 ack를 호출하지 않는다 — GA-29의 "resume 대기 중(닉네임
 * 미확정)"을 모사하기 위함이다.
 */
function createFakeSocket(getJoinResponse: () => JoinAck) {
  const listeners = new Map<string, Handler[]>();
  const socket = {
    io: { on: () => undefined },
    on(event: string, cb: Handler) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return socket;
    },
    off() {
      return socket;
    },
    close() {
      return undefined;
    },
    emit(event: string, payload: unknown, ack?: (result: unknown) => void) {
      if (event === 'join') {
        ack?.(getJoinResponse());
      } else if (event === 'identify') {
        const nickname = (payload as { nickname: string }).nickname;
        ack?.({ ok: true, nickname, token: 'tok-fresh' });
      } else if (event === 'activeRoom') {
        ack?.({ ok: true });
      }
      // 'resume'은 응답하지 않는다(GA-29: 유예 대기 중 모사).
      // 'message'는 ack 없는 fire-and-forget(protocol.ts) — 아무것도 하지 않는다.
    },
    /** 테스트에서 서버→클라이언트 이벤트를 주입한다. */
    trigger(event: string, payload?: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
  return socket;
}

const fake = vi.hoisted(() => {
  let joinResponse: unknown = { ok: true, history: [] };
  const sockets: unknown[] = [];
  return {
    getJoinResponse: () => joinResponse as never,
    setJoinResponse: (r: unknown) => {
      joinResponse = r;
    },
    sockets,
    io: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: fake.io }));

// vi.mock은 위로 호이스트되지만 실제 socket 생성 로직은 여기서 조립한다 —
// createFakeSocket이 이 시점에는 이미 정의돼 있어야 하므로 io mock 구현은
// 모듈 최상단(호이스트 밖)에서 지정한다(rq-10-a-session-resume.test.tsx와 동일).
fake.io.mockImplementation(() => {
  const socket = createFakeSocket(fake.getJoinResponse);
  fake.sockets.push(socket);
  // 실제 socket.io-client는 접속 후 비동기로 'connect'를 쏜다 — 마이크로태스크로 모사.
  queueMicrotask(() => socket.trigger('connect'));
  return socket;
});

const { useChat, TOKEN_KEY } = await import('../../src/client/useChat');

describe('RQ-13-a: useChat.joinRoom의 낙관적 갱신 롤백', () => {
  beforeEach(() => {
    localStorage.clear();
    fake.sockets.length = 0;
    fake.io.mockClear();
    fake.setJoinResponse({ ok: true, history: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('서버가 예약 이름을 거부하면 클라이언트가 참여 목록에 그 room을 남기지 않는다 (RQ-13, GA-28)', async () => {
    // given: user1 접속(닉네임 확정), 서버는 'GLOBAL'을 예약 이름으로 거부한다.
    fake.setJoinResponse({
      ok: false,
      error: "'global'은 예약된 이름이라 room 생성에 사용할 수 없다",
    });

    const { result } = renderHook(() => useChat('user1'));

    // 마운트 시 큐잉된 connect→identify 마이크로태스크를 act 안에서 흘려보낸다.
    await act(async () => {
      await Promise.resolve();
    });

    // when: user1이 이름 'GLOBAL'로 room 생성(참여)을 시도한다 — 서버 거부(ok:false).
    act(() => {
      result.current.joinRoom('GLOBAL');
    });

    // then: 참여 room 목록·활성 room·참여자 목록·메시지 패널 어디에도 남지 않는다.
    expect(result.current.rooms).not.toContain('GLOBAL');
    expect(result.current.activeRoom).not.toBe('GLOBAL');
    expect(result.current.participantsByRoom['GLOBAL']).toBeUndefined();
    expect(result.current.messagesByRoom['GLOBAL']).toBeUndefined();
  });

  it('거부 사유가 빈 nickname이어도 동일하게 롤백된다 (RQ-13, GA-29)', async () => {
    // given: user1이 resume 대기 중이라 본인 닉네임이 아직 확정되지 않았다(빈 문자열).
    // useChat(null)로 렌더 + localStorage에 토큰이 있어 resume 경로를 타지만,
    // 이 fake 소켓은 'resume' ack를 의도적으로 응답하지 않는다 — "대기 중" 그대로 둔다.
    localStorage.setItem(TOKEN_KEY, 'pending-token');
    fake.setJoinResponse({
      ok: false,
      error: 'room과 nickname은 비어 있지 않은 문자열이어야 한다',
    });

    const { result } = renderHook(() => useChat(null));

    await act(async () => {
      await Promise.resolve();
    });

    // 전제 확인: 닉네임이 아직 확정되지 않았다(빈 문자열).
    expect(result.current.nickname).toBe('');

    // when: user1이 room-A 참여를 시도해 서버가 nickname 검사로 거부(ok:false)한다.
    act(() => {
      result.current.joinRoom('room-A');
    });

    // then: GA-28과 같은 결과 — 클라이언트에 room-A가 남지 않는다.
    expect(result.current.rooms).not.toContain('room-A');
    expect(result.current.activeRoom).not.toBe('room-A');
    expect(result.current.participantsByRoom['room-A']).toBeUndefined();
    expect(result.current.messagesByRoom['room-A']).toBeUndefined();
  });

  it('서버가 승인하면 낙관적 갱신은 그대로 유지된다 — 대조군, 무조건 롤백 방지 (RQ-13, GA-30)', async () => {
    // given: user1 접속(닉네임 확정).
    // when: user1이 이름 room-A로 참여해 서버가 승인(ok:true)한다.
    fake.setJoinResponse({ ok: true, history: [] });

    const { result } = renderHook(() => useChat('user1'));

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.joinRoom('room-A');
    });

    // then: 낙관적 갱신이 그대로 유지된다 — room-A가 참여 목록에 있고 활성이 되며
    // 본인이 참여자로 seed된다. 롤백 도입이 성공 경로를 되돌리면 안 된다.
    expect(result.current.rooms).toContain('room-A');
    expect(result.current.activeRoom).toBe('room-A');
    expect(result.current.participantsByRoom['room-A']).toEqual(['user1']);
    expect(result.current.messagesByRoom['room-A']).toEqual([]);
  });
});
