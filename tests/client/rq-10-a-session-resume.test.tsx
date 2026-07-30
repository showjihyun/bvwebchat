// @vitest-environment jsdom
/**
 * RQ-10-a (specs/requirements.md §2 RQ-10, 세 번째 문장):
 * "같은 브라우저에서 새로고침하면, 시스템은 동일 사용자로 인식하고 참여
 * 중이던 room을 복원해야 한다 (서버 프로세스가 유지되는 동안)."
 *
 * ── 결함 (docs/progress.md RQ-10-a 행) ──
 * `src/client/App.tsx:7-12`: 닉네임이 React state에만 있고 `nickname === null`
 * 이면 무조건 `<EntryScreen>`을 띄운다. 세션 토큰(`useChat.ts:53` TOKEN_KEY)·
 * `resume`(useChat.ts:117-141, 서버 계약 ADR-0003)은 이미 배선되어 있어 room·
 * 안읽음·활성 room은 정상 복원되지만, **그 앞을 진입 화면이 막는다** — 사용자가
 * 닉네임을 다시 입력해야만 `useChat`이 mount된다(App.tsx가 `ChatApp`을
 * `nickname !== null`일 때만 렌더). 게다가 사용자가 이전과 다른 닉네임을
 * 입력하면 서버가 복원한 세션(ResumeAck.nickname)과 화면 표시가 어긋난다.
 *
 * ── 골든 케이스 매핑 ──
 * evals/golden/track-a-product.jsonl에서 RQ-10에 매핑된 것은 GA-09/GA-11뿐이고
 * 둘 다 identify 고유화만 다룬다(tests/integration/rq-10-nickname-identity.test.ts
 * 파일 상단 "스코프 경계" 절이 새로고침 복원을 명시적으로 범위 밖으로 선언).
 * 즉 **이 RQ-10-a에 매핑된 GA-* 골든 케이스는 없다** — 이 파일은 스펙 문장
 * 자체(위 인용)를 직접 인수 기준으로 삼는 결함 수정 테스트다.
 *
 * ── 테스트 더블 경계 (ADR-0005 결정4: 전송 계층만 대체) ──
 * `socket.io-client`의 `io()` 팩토리만 목으로 대체한다. 서버 프로토콜
 * (identify/resume/message 등)은 `src/server/chat/protocol.ts`·`session.ts`의
 * 실제 계약을 그대로 흉내 낸다 — 새 이벤트를 창작하지 않는다. 특히
 * `handleResume`(session.ts:255-305)은 'participants' 브로드캐스트를 하지
 * 않으므로(코드로 확인함) 이 테스트도 그것을 가정하지 않는다.
 *
 * ── 무엇을 검증하는가 ──
 * 1) 유효한 세션 토큰이 있으면 `EntryScreen`(닉네임 입력 폼)을 건너뛰고,
 *    서버가 resume ack로 돌려준 방과 닉네임이 화면에 반영된다. "화면에 뜨는
 *    닉네임이 서버가 돌려준 값인가"를 직접 묻기 위해, 그 닉네임으로 온
 *    'message' 이벤트(기존 프로토콜, 변경 없음)가 "나" 배지로 표시되는지
 *    확인한다 — App이 로컬에서 닉네임을 지어내거나 별도로 캐싱하지 않았음의
 *    증거다(localStorage에 별도 닉네임 키를 두지 않는다는 팀리드 제약과 직결).
 * 2) 토큰이 없으면 `EntryScreen`으로 폴백한다.
 * 3) 토큰이 있어도 resume이 거부되면(유예 만료·무효 토큰) `EntryScreen`으로
 *    폴백한다 — 이게 없으면 "유효한 세션은 복원"만 만족시키는 구현이
 *    사실상 영구 로그인이 되어 폴백 경로를 잃는다(팀리드 지시 사항).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';

type ResumeAck =
  | { ok: true; nickname: string; rooms: string[]; activeRoom: string | null; unread: Record<string, number> }
  | { ok: false; error: string };
type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };
type Handler = (payload?: unknown) => void;

/**
 * `socket.io-client`의 `io()`를 대체하는 최소 목. useChat.ts가 실제로 쓰는
 * 표면(`on`/`emit`/`close`/`io.on`)만 구현한다. `emit`은 이벤트별로 서버 계약과
 * 동일한 shape의 ack를 동기 호출한다 — 실제로는 비동기지만, 순서(요청→ack)만
 * 보존하면 되는 클라이언트 배선 테스트이므로 fake timer 없이 동기 처리한다.
 */
function createFakeSocket(
  getResumeResponse: () => ResumeAck,
  getIdentifyResponse: () => IdentifyAck,
) {
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
      if (event === 'resume') ack?.(getResumeResponse());
      else if (event === 'identify') ack?.(getIdentifyResponse());
      else if (event === 'activeRoom') ack?.({ ok: true });
      else if (event === 'join') ack?.({ ok: true, history: [] });
      // 'message'는 ack 없는 fire-and-forget(protocol.ts) — 아무것도 하지 않는다.
    },
    /** 테스트에서 서버→클라이언트 이벤트를 주입한다. */
    trigger(event: string, payload?: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
  return socket;
}

type FakeSocket = ReturnType<typeof createFakeSocket>;

const fake = vi.hoisted(() => {
  let resumeResponse: unknown = { ok: false, error: 'no-session' };
  let identifyResponse: unknown = { ok: true, nickname: 'guest', token: 'tok-fresh' };
  const sockets: unknown[] = [];
  return {
    getResumeResponse: () => resumeResponse as never,
    setResumeResponse: (r: unknown) => {
      resumeResponse = r;
    },
    getIdentifyResponse: () => identifyResponse as never,
    setIdentifyResponse: (r: unknown) => {
      identifyResponse = r;
    },
    sockets,
    io: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: fake.io }));

// vi.mock은 위로 호이스트되지만 실제 socket 생성 로직은 여기서 조립한다 —
// createFakeSocket이 이 시점에는 이미 정의돼 있어야 하므로 io mock 구현은
// 모듈 최상단(호이스트 밖)에서 지정한다.
fake.io.mockImplementation(() => {
  const socket = createFakeSocket(fake.getResumeResponse, fake.getIdentifyResponse);
  fake.sockets.push(socket);
  // 실제 socket.io-client는 접속 후 비동기로 'connect'를 쏜다 — 마이크로태스크로 모사.
  queueMicrotask(() => socket.trigger('connect'));
  return socket;
});

const { App } = await import('../../src/client/App');

const TOKEN_KEY = 'bvwebchat.sessionToken';

function latestSocket(): FakeSocket {
  const s = fake.sockets[fake.sockets.length - 1];
  if (!s) throw new Error('io()가 아직 호출되지 않았다 — 소켓이 없다');
  return s as FakeSocket;
}

describe('RQ-10-a: 새로고침 시 유효한 세션이면 닉네임 재입력 없이 복원된다', () => {
  beforeEach(() => {
    localStorage.clear();
    fake.sockets.length = 0;
    fake.io.mockClear();
    fake.setResumeResponse({ ok: false, error: 'no-session' });
    fake.setIdentifyResponse({ ok: true, nickname: 'guest', token: 'tok-fresh' });
  });

  afterEach(() => {
    cleanup();
  });

  it('RQ-10-a: 유효한 세션 토큰이 있으면 EntryScreen을 건너뛰고 서버가 돌려준 닉네임·room으로 복원된다', async () => {
    localStorage.setItem(TOKEN_KEY, 'valid-token');
    fake.setResumeResponse({
      ok: true,
      nickname: 'alice',
      rooms: ['room-a'],
      activeRoom: 'room-a',
      unread: {},
    });

    render(<App />);

    // then: 닉네임을 다시 입력하라는 EntryScreen이 뜨지 않는다 (결함의 핵심).
    // jest-dom 미설치(package.json에 없음) — toBeInTheDocument 대신 순수 vitest
    // 매처(toBeNull)로 부재를 확인한다.
    await waitFor(() => {
      expect(screen.queryByLabelText('닉네임')).toBeNull();
    });

    // then: resume ack가 돌려준 room('room-a')이 사이드바에 나타난다 — 이 값은
    // 서버 세션에서만 나올 수 있다(클라이언트가 지어낼 수 없는 임의 문자열).
    // getByText는 못 찾으면 스스로 throw하므로(존재 증명), waitFor 재시도만 걸면 된다.
    await waitFor(() => {
      screen.getByText('room-a');
    });

    // then: 서버가 돌려준 닉네임('alice')이 실제로 화면 상태에 쓰였는지 —
    // 그 닉네임으로 온 기존 'message' 이벤트(RQ-01/02, 변경 없음)가 "나"
    // 배지로 표시되는지로 검증한다. App이 로컬에서 다른 값을 쓰고 있었다면
    // 이 배지는 뜨지 않는다.
    await act(async () => {
      latestSocket().trigger('message', { room: 'room-a', nickname: 'alice', body: 'hello self' });
    });

    const body = await screen.findByText('hello self');
    const row = body.closest('.msg-row');
    expect(row).not.toBeNull();
    within(row as HTMLElement).getByText('나'); // 못 찾으면 throw — 존재 증명.
  });

  it('RQ-10-a: 세션 토큰이 없으면 EntryScreen으로 폴백한다', async () => {
    // localStorage에 토큰 없음 (beforeEach가 clear() 수행).
    render(<App />);

    await waitFor(() => {
      screen.getByLabelText('닉네임');
    });
  });

  it('RQ-10-a: 세션 토큰이 있어도 resume이 거부되면(유예 만료·무효 토큰) EntryScreen으로 폴백한다', async () => {
    localStorage.setItem(TOKEN_KEY, 'expired-token');
    fake.setResumeResponse({ ok: false, error: '세션을 찾을 수 없다(만료되었거나 존재하지 않는다)' });

    render(<App />);

    await waitFor(() => {
      screen.getByLabelText('닉네임');
    });
  });
});
