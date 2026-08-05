// @vitest-environment jsdom
/**
 * RQ-15-b (specs/requirements.md:44 RQ-15, "시스템은 각 room의 현재 참여자
 * 목록을 표시해야 한다") — resume(새로고침) 경로에서만 미이행이던 것을 닫는다.
 * join·leave 축(GA-19/20, tests/integration/rq-15-participants.test.ts)은 이미
 * done — 이 파일은 **resume 축**만 다룬다.
 *
 * ── 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-15) ──
 *
 * GA-35
 *   given: user1(alice)·user2(bob)가 room-A에 참여, 두 사람 모두 참여자 목록
 *          [alice, bob]을 보고 있다.
 *   when : user1이 새로고침 후 동일 세션 토큰으로 재접속한다(퇴장 유예 30초
 *          내). 그 사이 아무도 room-A에 참여하거나 퇴장하지 않는다.
 *   then : user1의 참여자 패널에 [alice, bob]이 다시 표시된다 — 제3자가
 *          움직이기를 기다리지 않는다.
 *
 * GA-36
 *   given: user1(alice)이 room-A에 혼자 참여 중이고 참여자 패널에 [alice]가
 *          보인다.
 *   when : user1이 새로고침 후 동일 세션 토큰으로 재접속한다(퇴장 유예 30초 내).
 *   then : user1의 참여자 패널에 [alice]가 다시 표시된다 — 본인이 사라지지
 *          않는다.
 *
 * GA-36을 GA-35와 분리한 이유(골든 note, 구현 함정): join 경로의 참여자
 * 방송은 `src/server/chat/room.ts:76` 이 `memberCount > 1`일 때만 보낸다
 * (의도된 경합 회피 — room.ts:67-75 주석). 클라이언트는 `useChat.ts:313`에서
 * join 시 본인을 로컬로 seed해 그 간극을 메운다. **resume 경로에는 그 로컬
 * seed가 없다** — 따라서 resume의 참여자 방송에 같은 `> 1` 게이트를 그대로
 * 복사하면 혼자 있는 room에서 결함이 재생산되고 GA-35(2인)만으로는 잡히지
 * 않는다. 이 파일이 GA-35/GA-36을 각각 별도 축으로 두는 것은 그래서다.
 *
 * ── 결함 (test-writer가 코드로 직접 확인, docs/progress.md RQ-15-b 행과 동일) ──
 * `src/server/chat/session.ts:255` `handleResume`이 `:293-297`에서
 * `socket.join(room)` + `replaceMember`까지만 하고 `broadcastParticipants`를
 * **호출하지 않는다**. ack(`:304`)도 `ok·nickname·rooms·activeRoom·unread`만
 * 싣는다. `:35`의 `./broadcast` import가 `emitUnreadToSocket`·
 * `emitUnreadToSocketId` 둘뿐이라 그 심볼이 이 파일에 아예 없다.
 * 클라: `src/client/useChat.ts:186-201`의 resume 성공 핸들러가 `rooms`·
 * `unread`·`messagesByRoom`(`:200`)만 seed하고 `participantsByRoom`은 건너뛴다.
 * 본인 seed는 `:313`의 join 경로에만 있고 resume은 그 경로를 타지 않는다.
 * 결과: `src/client/components/ChatApp.tsx:25`의
 * `participantsByRoom[activeRoom] ?? []`가 빈 배열이 되어 참여자 패널이
 * 영구히 빈다(제3자가 움직이기 전까지).
 *
 * 실행 재현(2026-08-05, `_workspace/RQ-15-b/repro-resume-participants.ts` +
 * `repro-output.txt`): resume ack 키 = `["ok","nickname","rooms","activeRoom",
 * "unread"]`(participants 없음), 재접속한 alice·남아 있던 bob 모두 1200ms 내
 * `participants` 수신 0건. 대조군(carol join)이 오자 그제야 도착 — 방송 자체가
 * 없는 것이 원인이고, 아무도 안 움직이면 영구 공백이다.
 *
 * ── 테스트 레벨 (ADR-0005 결정4 판별 질문: "이 단언이 참이 되려면 서버가
 * 무엇을 답해야 하는가?") ──
 * 답은 "resume 직후 participants 방송"이다 — 서버가 답할 것이 있으므로
 * `tests/integration/`에서 실 `createChatServer` + 실 `socket.io-client`로
 * 검증한다(전송 계층만 대체 허용, ADR-0005 결정4). `io()`를 전면 목으로
 * 대체해 ack을 창작하지 않는다(RQ-10-a의 반례로 지목된 실수 — ADR-0005 결정4
 * 참고).
 *
 * ── 두 축을 같은 파일에 둔 이유 (GA-34 교훈, docs/progress.md RQ-15-a 행) ──
 * GA-34는 골든의 `when`(실제 사용자 조작 경로)을 어느 테스트도 지나가지
 * 않아 배선이 무방비였던 선례다. 그래서 이 파일은:
 *   (1) **서버 계약 축(raw socket)** — `handleResume`이 실제로
 *       `broadcastParticipants`를 부르는지, GA-35/36 각각의 조건(2인/1인)에서
 *       직접 잠근다. 빠르고 결함 지점을 정밀 조준한다.
 *   (2) **클라이언트 표면 축(실제 새로고침)** — `App`을 렌더해 실제로
 *       닉네임 입장 → room 참여 → **언마운트 후 재렌더**(토큰은 localStorage에
 *       남는다 — 이것이 브라우저 새로고침과 동형이다)까지 실 사용자 경로를
 *       지나가며 참여자 패널(`ParticipantList`)이 실제로 그 값을 그리는지
 *       확인한다. (1)만으로는 "서버가 방송한다"는 잠그지만 "클라가 그걸
 *       받아 화면에 그린다"는 잠그지 않는다 — `useChat.ts`의 `participants`
 *       리스너(`:238`) 자체는 이미 존재하므로 이론상 이어붙기만 하면 되지만,
 *       그 배선이 실제로 새로고침 경로를 타는지는 렌더 축이 아니면 증명되지
 *       않는다(GA-34와 같은 사각지대).
 *
 * ── 자기검증 메모 (test-writer) ──
 * 4개 테스트(raw×2 + render×2) 모두 현재 코드에서 반드시 실패한다:
 *   - GA-35/36 raw: `alice2`가 resume 후 `participants` 이벤트를 기다리는
 *     promise가 위 실행 재현대로 절대 resolve되지 않는다 — `waitForParticipantsEvent`의
 *     타임아웃(2000ms)으로 reject해 테스트가 실패한다(`handleResume`이
 *     `broadcastParticipants`를 호출하는 코드 경로 자체가 없으므로).
 *   - GA-35/36 render: 재렌더된 `ChatApp`의 `participantsByRoom['room-A']`가
 *     resume 경로에서 채워지지 않으므로(위 결함), `.people-body .person`이
 *     0개로 남아 "[alice, bob]" / "[alice]" 재표시 단언이 실패한다.
 * 리팩터로 통과하려면 `handleResume`이 `io`를 받아 재합류 루프 뒤 non-global
 * room마다 `broadcastParticipants(io, state, room)`을 호출해야 하고(GA-35),
 * 그 호출에 `room.ts:76`의 `memberCount > 1` 게이트를 복사하면 안 된다(GA-36).
 * 클라이언트 변경은 0으로 예상된다 — `useChat.ts:238`의 `participants` 리스너가
 * `:179`의 `connect` 핸들러(그 안에서 resume을 emit)보다 먼저 등록되므로
 * 경합 없이 그대로 소비한다(progress.md RQ-15-b "사용자 결정" 절 근거).
 */
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { TOKEN_KEY } from '../../src/client/useChat';

type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };
type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };
type ResumeAck =
  | { ok: true; nickname: string; rooms: string[]; activeRoom: string | null; unread: Record<string, number> }
  | { ok: false; error: string };
interface ParticipantsPayload {
  room: string;
  participants: string[];
}

/**
 * `socket.io-client`의 `io()`를 대체해 URL 없는 호출(useChat.ts의 `io({...})`,
 * 즉 App/ChatApp 내부 호출)만 이 테스트 서버로 리다이렉트한다. URL을 직접
 * 넘기는 raw 소켓 호출(`ioClient(url, ...)`)은 그대로 실서버로 간다 —
 * `tests/integration/rq-18-a-global-render.test.ts`·
 * `tests/integration/rq-15-a-global-participants-wiring.test.ts`와 동일 기법
 * (ADR-0005 결정4 실증). ack을 대신 회신하지 않는다 — 전송(URL 해석)만
 * 대체한다. 유일한 관측(기록만, 응답 조작 없음)은 `activeRoom` emit의 실제
 * 서버 ack이다 — `joinRoom` 성공 후 나가는 `activeRoom` emit(useChat.ts:381)이
 * 실제로 서버에 도달해 세션의 `activeRoom`이 확정된 시점을 알아야, 새로고침을
 * 그 **이전에** 트리거해 resume ack의 `activeRoom`이 아직 `null`인 채로
 * "참여자 패널이 비어 있다"는 것과, resume이 실제로 `activeRoom='room-A'`를
 * 복원했는데도 participants가 비어 있는 것을 구분할 수 있다(전자는 이 결함과
 * 무관한 레이스, 후자가 이 파일이 잠그는 결함).
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
      uri = first;
      opts = (args[1] as Record<string, unknown> | undefined) ?? {};
    } else {
      uri = fake.getUrl();
      opts = (first as Record<string, unknown> | undefined) ?? {};
    }
    const socket = actual.io(uri, { ...opts, forceNew: true });
    const originalEmit = socket.emit.bind(socket);
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

// useChat(따라서 ChatApp/App)이 위 vi.mock을 실제로 통해 socket.io-client를
// 가져오도록 mock 설정 뒤에 동적 import한다(rq-18-a-global-render.test.ts와 동일 관례).
const { App } = await import('../../src/client/App');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** raw 클라이언트 소켓(useChat을 거치지 않음). */
function connectRaw(url: string, cleanupFns: Array<() => void | Promise<void>>): ClientSocket {
  const socket = ioClient(url, { forceNew: true });
  cleanupFns.push(() => {
    socket.disconnect();
  });
  return socket;
}

function waitForIdentifyAck(
  socket: ClientSocket,
  payload: { nickname: string },
  timeoutMs = 2000,
): Promise<IdentifyAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`'identify' ack가 ${timeoutMs}ms 내에 도착하지 않았다`)), timeoutMs);
    socket.emit('identify', payload, (ack: IdentifyAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitForJoinAck(
  socket: ClientSocket,
  payload: { room: string; nickname: string },
  timeoutMs = 2000,
): Promise<JoinAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`'join' ack가 ${timeoutMs}ms 내에 도착하지 않았다`)), timeoutMs);
    socket.emit('join', payload, (ack: JoinAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitForResumeAck(socket: ClientSocket, payload: { token: string }, timeoutMs = 2000): Promise<ResumeAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`'resume' ack가 ${timeoutMs}ms 내에 도착하지 않았다`)), timeoutMs);
    socket.emit('resume', payload, (ack: ResumeAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/**
 * 지정 room에 대한 'participants' 이벤트만 걸러 대기한다(다른 room의 이벤트는
 * 무시). timeoutMs 내에 오지 않으면 reject한다(ADR-0005 — 모든 대기에 상한).
 * `tests/integration/rq-15-participants.test.ts`의 동일 헬퍼와 같은 계약.
 */
function waitForParticipantsEvent(
  socket: ClientSocket,
  room: string,
  timeoutMs = 2000,
): Promise<ParticipantsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('participants', onParticipants);
      reject(new Error(`'participants' 이벤트(room=${room})가 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    function onParticipants(payload: ParticipantsPayload): void {
      if (payload.room !== room) return;
      clearTimeout(timer);
      socket.off('participants', onParticipants);
      resolve(payload);
    }
    socket.on('participants', onParticipants);
  });
}

/** 실 서버 왕복(비동기 네트워크 I/O)이 반영될 때까지 폴링한다 — 상한 명시(ADR-0005). */
async function waitForUi(assertion: () => void, timeoutMs = 3000): Promise<void> {
  await waitFor(assertion, { timeout: timeoutMs });
}

/**
 * identify(또는 resume)의 ack가 실제로 처리되어 세션 토큰이 localStorage에
 * 저장될 때까지 기다린다 — 이 파일의 다른 신호로는 이 시점을 알 수 없다:
 * `RoomList`는 GLOBAL_ROOM을 서버 상태와 무관하게 항상 합성 렌더하므로
 * (`src/client/components/RoomList.tsx:23`) room-item 존재는 신호가 못 되고,
 * `joinRoom`의 낙관적 갱신(`useChat.ts:296-316`)도 서버 왕복 **전**에 이미
 * 헤더·참여자 패널을 채우므로 그 상태로도 identify 완료를 증명하지 못한다.
 * (test-writer 자기검증 — 최초 초안은 room-item 존재를 게이트로 썼다가 GA-36
 * 클라이언트 축에서 새로고침 직전 identify ack이 아직 안 끝난 채로
 * `cleanup()`이 실행돼 `resume`이 `ok:false`로 실패하는 레이스를 실측했다.)
 */
async function waitForTokenStored(): Promise<void> {
  await waitForUi(() => {
    expect(localStorage.getItem(TOKEN_KEY)).not.toBeNull();
  });
}

/** ChatPane 헤더(`# room`)의 정규화된 텍스트를 읽는다. */
function getChatHeaderText(): string {
  return document.querySelector('.chat-head-name')?.textContent?.trim() ?? '';
}

/** 참여자 패널 본문(`.people-body`) 엘리먼트를 가져온다. 없으면 즉시 throw(구조 자체의 결함). */
function getParticipantsBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>('.people-body');
  if (!body) {
    throw new Error('.people-body가 렌더되지 않았다 — ParticipantList가 마운트되지 않았다');
  }
  return body;
}

/** 참여자 패널에 렌더된 `.person` 행의 표시 이름을 join 순서 그대로 반환한다. */
function getPersonNames(): string[] {
  return Array.from(getParticipantsBody().querySelectorAll('.person .person-name')).map(
    (el) => el.textContent?.trim() ?? '',
  );
}

/** EntryScreen에서 닉네임을 입력해 입장한다(RQ-10-a와 동일 폼 계약). */
async function enterNickname(name: string): Promise<void> {
  const input = await screen.findByLabelText('닉네임');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '입장' }));
}

/** "+ room 참여" → 이름 입력 → "참여" 제출까지 모달을 통해 room에 참여한다. */
async function joinRoomViaModal(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '+ room 참여' }));
  const input = await screen.findByLabelText('room 이름');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '참여' }));
}

/**
 * 모달로 room에 참여하고, **서버가 join을 승인한 뒤 훅이 보낸 `activeRoom`
 * emit의 실제 ack이 도착할 때까지** 기다린다(`rq-18-a-global-render.test.ts`·
 * `rq-15-a-global-participants-wiring.test.ts`와 동일 근거) — 그래야
 * 세션의 서버측 `activeRoom`이 실제로 `room-A`로 확정된 뒤에 새로고침을
 * 트리거할 수 있다. 낙관적 로컬 상태(헤더 텍스트)만 보고 넘어가면, 아직
 * 서버 왕복이 끝나기 전에 언마운트해 resume ack의 `activeRoom`이 `null`인
 * 채로 도착하는 별개의 레이스를 이 결함(참여자 미방송)과 혼동하게 된다.
 */
async function joinRoomAndBecomeActive(name: string): Promise<void> {
  const baseline = fake.activeRoomAcks.length;
  await joinRoomViaModal(name);
  await waitForUi(() => {
    expect(fake.activeRoomAcks.length).toBeGreaterThan(baseline);
  });
  expect(fake.activeRoomAcks[fake.activeRoomAcks.length - 1]).toEqual({ ok: true });
  await waitForUi(() => {
    expect(getChatHeaderText()).toBe(`# ${name}`);
  });
}

beforeEach(() => {
  localStorage.clear();
  fake.activeRoomAcks.length = 0;
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// 축 1: 서버 계약(raw socket) — handleResume이 실제로 participants를 방송하는가
// ─────────────────────────────────────────────────────────────────────────

describe('RQ-15-b / GA-35 (서버 계약): resume 직후 room-A participants 방송이 온다 — 제3자 이동 없이 (2인)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice·bob이 room-A에 함께 있는 상태에서 alice가 연결을 끊고 동일 토큰으로 재접속(resume)하면, 그 사이 아무도 움직이지 않았는데도 재접속 소켓이 room-A participants=[alice, bob] 방송을 받는다 (RQ-15, GA-35)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice1 = connectRaw(url, cleanupFns);
      const bob = connectRaw(url, cleanupFns);

      // given: alice(identify로 세션 토큰 발급)·bob이 room-A에 함께 참여해
      // 두 사람 모두 참여자 목록 [alice, bob]을 보고 있다.
      const aliceIdentify = await waitForIdentifyAck(alice1, { nickname: 'alice' });
      if (!aliceIdentify.ok) throw new Error(`alice identify 실패: ${aliceIdentify.error}`);
      const token = aliceIdentify.token;

      const aliceSeesGiven = waitForParticipantsEvent(alice1, 'room-A');
      expect((await waitForJoinAck(alice1, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
      const bobSeesGiven = waitForParticipantsEvent(bob, 'room-A');
      expect((await waitForJoinAck(bob, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);

      const givenPayload: ParticipantsPayload = { room: 'room-A', participants: ['alice', 'bob'] };
      await expect(aliceSeesGiven).resolves.toEqual(givenPayload);
      await expect(bobSeesGiven).resolves.toEqual(givenPayload);

      // when: alice가 새로고침한다(소켓을 끊고 짧은 실 지연 후 같은 토큰으로
      // 재접속) — 그 사이 bob은 아무것도 하지 않는다(golden when 절의 핵심).
      alice1.disconnect();
      await sleep(150);

      const alice2 = connectRaw(url, cleanupFns);
      // resume emit 전에 리스너를 먼저 건다 — ack과 방송의 도착 순서를
      // 가정하지 않기 위해서다.
      const alice2SeesResumeBroadcast = waitForParticipantsEvent(alice2, 'room-A');
      await new Promise<void>((resolve) => alice2.on('connect', () => resolve()));
      const resumeAck = await waitForResumeAck(alice2, { token });
      expect(resumeAck.ok).toBe(true);

      // then: alice의 새 소켓이 room-A participants=[alice, bob]을 받는다 —
      // bob이 이번 when 동안 아무것도 하지 않았으므로, 이 방송은 오직
      // resume 자체가 유발한 것이어야 한다.
      await expect(alice2SeesResumeBroadcast).resolves.toEqual(givenPayload);
    },
  );
});

describe('RQ-15-b / GA-36 (서버 계약): 혼자인 room도 resume 직후 participants 방송에 본인이 남는다 (1인, 구현 함정 축)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'alice 혼자 room-A에 참여 중일 때(참여자 목록 [alice]) 연결을 끊고 동일 토큰으로 재접속(resume)하면, 재접속 소켓이 room-A participants=[alice] 방송을 받는다 — join의 memberCount>1 게이트를 복사하면 이 케이스가 재현된다 (RQ-15, GA-36)',
    async () => {
      const url = await startServer(cleanupFns);
      const alice1 = connectRaw(url, cleanupFns);

      // given: alice 혼자 room-A에 참여 — founding join(memberCount=1)이라
      // room.ts:76의 게이트로 서버가 이 시점엔 participants를 방송하지 않는다
      // (기존 GA-19/20 축의 정상 동작, 이 테스트가 규정하지 않는다).
      const aliceIdentify = await waitForIdentifyAck(alice1, { nickname: 'alice' });
      if (!aliceIdentify.ok) throw new Error(`alice identify 실패: ${aliceIdentify.error}`);
      const token = aliceIdentify.token;
      expect((await waitForJoinAck(alice1, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);

      // when: alice가 새로고침한다.
      alice1.disconnect();
      await sleep(150);

      const alice2 = connectRaw(url, cleanupFns);
      const alice2SeesResumeBroadcast = waitForParticipantsEvent(alice2, 'room-A');
      await new Promise<void>((resolve) => alice2.on('connect', () => resolve()));
      const resumeAck = await waitForResumeAck(alice2, { token });
      expect(resumeAck.ok).toBe(true);

      // then: 1인 room이라도 resume은 participants=[alice]를 방송한다 — join의
      // "혼자면 생략" 게이트(room.ts:76)를 resume에 그대로 복사하면 이 단언이
      // 영구히 실패한다(GA-36이 존재하는 이유).
      await expect(alice2SeesResumeBroadcast).resolves.toEqual({ room: 'room-A', participants: ['alice'] });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 축 2: 클라이언트 표면(실제 새로고침) — App을 실제로 언마운트·재렌더해
// 참여자 패널이 그 값을 화면에 그리는지 확인한다.
// ─────────────────────────────────────────────────────────────────────────

describe('RQ-15-b / GA-35 (클라이언트 표면): 실제 새로고침 후 참여자 패널에 [alice, bob]이 다시 표시된다 (2인)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1(alice)이 UI로 room-A에 참여하고 bob이 합류해 참여자 패널에 [alice, bob]이 보이는 상태에서, alice가 새로고침(언마운트→재렌더, 토큰은 localStorage에 남는다)해도 아무도 움직이지 않았는데 참여자 패널에 [alice, bob]이 다시 표시된다 (RQ-15, GA-35)',
    async () => {
      const url = await startServer(cleanupFns);

      // given 1: alice가 EntryScreen으로 실제 입장하고 room-A에 참여해
      // 활성 room으로 만든다 — 실 사용자 조작 경로(GA-34 교훈: 직접 prop
      // 주입이 아니라 클릭으로 지나가야 배선이 잠긴다).
      render(createElement(App));
      await enterNickname('alice');
      await waitForTokenStored();
      await joinRoomAndBecomeActive('room-A');

      // given 2: bob(raw socket)이 room-A에 합류한다 — 서버가 2인 방송을
      // 보내 alice의 패널이 로컬 seed([alice])에서 권위 목록([alice, bob])으로
      // 갱신된다. bob 자신도 이 방송을 받는지까지 확인해 golden의 given
      // ("두 사람 모두 … 보고 있다")을 그대로 잠근다.
      const bob = connectRaw(url, cleanupFns);
      const bobSeesGiven = waitForParticipantsEvent(bob, 'room-A');
      expect((await waitForJoinAck(bob, { room: 'room-A', nickname: 'bob' })).ok).toBe(true);
      await expect(bobSeesGiven).resolves.toEqual({ room: 'room-A', participants: ['alice', 'bob'] });
      await waitForUi(() => {
        expect(getPersonNames()).toEqual(['alice', 'bob']);
      });

      // when: alice가 새로고침한다 — 렌더 트리를 언마운트(useChat의 effect
      // cleanup이 socket.close()를 실제로 호출)하고, 세션 토큰은
      // localStorage에 남은 채로 App을 다시 렌더한다. bob은 그 사이 아무
      // 행동도 하지 않는다(golden when 절 그대로).
      cleanup();
      await sleep(150);
      render(createElement(App));

      // then: 재렌더된 App이 토큰으로 resume하고, activeRoom(room-A)이
      // 자동 복원되며, 참여자 패널에 [alice, bob]이 다시 표시된다 — 이
      // 시점까지 bob을 포함해 아무도 추가로 움직이지 않았다.
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe('# room-A');
      });
      await waitForUi(() => {
        expect(getPersonNames()).toEqual(['alice', 'bob']);
      });
      const aliceRow = Array.from(getParticipantsBody().querySelectorAll('.person')).find(
        (el) => el.querySelector('.person-name')?.textContent?.trim() === 'alice',
      );
      if (!aliceRow) throw new Error('alice 행을 찾을 수 없다');
      within(aliceRow as HTMLElement).getByText('나'); // 못 찾으면 throw — 존재 증명.
    },
    10000,
  );
});

describe('RQ-15-b / GA-36 (클라이언트 표면): 혼자인 room도 새로고침 후 참여자 패널에 본인이 남는다 (1인, 구현 함정 축)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1(alice)이 room-A에 혼자 참여 중이고 참여자 패널에 [alice]가 보이는 상태에서, 새로고침(언마운트→재렌더)해도 참여자 패널에 [alice]가 다시 표시된다 — 본인이 사라지지 않는다 (RQ-15, GA-36)',
    async () => {
      await startServer(cleanupFns);
      render(createElement(App));

      // given: alice가 혼자 room-A에 참여한다 — join의 founding-join
      // seed(useChat.ts:313)로 패널에 로컬로 [alice]가 즉시 보인다(서버 방송
      // 없이도 성립하는 기존 동작, 이 테스트가 새로 규정하는 것이 아니다).
      await enterNickname('alice');
      await waitForTokenStored();
      await joinRoomAndBecomeActive('room-A');
      await waitForUi(() => {
        expect(getPersonNames()).toEqual(['alice']);
      });

      // when: alice가 새로고침한다 — 그 사이 room-A는 계속 혼자다.
      cleanup();
      await sleep(150);
      render(createElement(App));

      // then: 참여자 패널에 [alice]가 다시 표시된다 — join 경로의 로컬
      // seed는 resume 경로를 타지 않으므로, 서버가 resume 후 1인이라도
      // participants를 방송해야만 이 단언이 성립한다(GA-36 note가 경고하는
      // "join의 memberCount>1 게이트를 resume에 복사"하면 여기서 영구히
      // 실패한다 — 빈 패널로 남는다).
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe('# room-A');
      });
      await waitForUi(() => {
        expect(getPersonNames()).toEqual(['alice']);
      });
      const aliceRow = getParticipantsBody().querySelector('.person');
      if (!aliceRow) throw new Error('alice 행을 찾을 수 없다 — 참여자 패널이 비어 있다');
      within(aliceRow as HTMLElement).getByText('나'); // 못 찾으면 throw — 존재 증명.
    },
    10000,
  );
});
