// @vitest-environment jsdom
/**
 * RQ-15-a / GA-34 — 배선(wiring) 축, 리뷰어 blocker 폐쇄용 재호출.
 *
 * evals/golden/track-a-product.jsonl 마지막 줄(GA-34):
 *   given: user1이 접속해 room 목록에 global이 보이는 상태(RQ-18-a). global은
 *          ADR-0008에 따라 참여자 목록을 갖지 않는다.
 *   when : user1이 global을 활성 room으로 선택한다.
 *   then : 참여자 패널이 빈 칸이 아니라 '참여자 목록이 없다'는 것과 그 이유를
 *          표시한다. user room을 선택하면 종전대로 참여자 목록이 나온다.
 *
 * ── 이 파일이 새로 생긴 이유 (골든 신설 아님 — GA-34의 배선 축) ──
 * 기존 `tests/client/rq-15-a-global-participants.test.tsx`는 `ParticipantList`를
 * *직접* 렌더하며 `isGlobal` prop을 테스트가 손으로 넘긴다. 그 파일은 여전히
 * 유효한 컴포넌트 계약 테스트로 존치한다(리뷰어 판정, 건드리지 않는다) — 다만
 * `ChatApp`이 그 prop을 *실제로* 계산해 넘기는지는 그 파일 어디에서도 검증되지
 * 않는다. 리뷰어 실측: `ChatApp`의 `isGlobal` 계산을 `false`로 바꿔도(즉 global
 * 활성 시에도 항상 false를 넘기도록 뮤테이션해도) 기존 스위트가 65/65 그대로
 * 초록이었다 — GA-34의 `when`("user1이 global을 활성 room으로 선택한다")이 실제
 * 사용자 조작 경로(클릭 → useChat → ChatApp → ParticipantList)로는 단 한 번도
 * 지나가지 않기 때문이다. 이 파일이 그 배선 자체를 잠근다.
 *
 * ── 왜 tests/integration/인가 (ADR-0005 결정4 판별 질문) ──
 * "이 단언이 참이 되려면 서버가 무엇을 답해야 하는가?" → 있다. "global을 활성
 * room으로 선택한다"는 `activeRoom` emit이 실제로 서버 왕복(ack)을 거치는
 * 경로이고(GA-33이 이미 그 경로를 잠갔다), 그 ack이 ok:true로 확정된 뒤에야
 * `ChatApp`이 `ParticipantList`에 무엇을 넘기는지가 의미 있는 관찰이 된다.
 * `ParticipantList`를 직접 렌더하는 순수 렌더 테스트로는 "ChatApp이 배선을
 * 했는가"를 절대 검증할 수 없다 — 그것이 정확히 이 blocker의 정의다. 그래서
 * `tests/integration/rq-18-a-global-render.test.ts`의 하네스(실 `createChatServer`
 * + 실 `socket.io-client`, 전송 대역은 URL 리다이렉트와 `activeRoom` ack 관측
 * 뿐)를 그대로 재사용한다 — 목이 ack을 대신 회신하면 "서버가 global을 활성
 * room으로 실제로 받아주는가"라는 계약이 검증에서 사라지는 것과 동형으로,
 * ChatApp→ParticipantList 배선도 목으로 우회하면 사라진다.
 *
 * ── 단언 매핑 ──
 * 1) GA-34 when("global을 활성 room으로 선택") + then("빈 칸이 아니라 이유를
 *    표시") — `ChatApp`을 렌더해 실제로 global을 클릭하고 서버 ack을 확인한
 *    뒤, `.people-body` 안에 `.pending-note` 이유 노드가 있고 비어있지 않음을
 *    확인한다. 참여자 "누구인가"는 여전히 단언하지 않는다(ADR-0008 범위 밖).
 * 2) GA-34 then("user room을 선택하면 종전대로 참여자 목록이 나온다") — 회귀
 *    축. user room은 서버가 `memberCount > 1`일 때만 `participants`를
 *    방송하므로(src/server/chat/state.ts:148 주석, room.ts:76) 관찰자 소켓을
 *    하나 더 붙여 실제 방송을 유도하고, `.person` 행이 렌더됨을 확인한다.
 *
 * ── 자기검증 메모 (test-writer) ──
 * 현재 브랜치는 구현이 revert된 상태다(커밋 `27d8cc7 Revert "feat(RQ-15-a)…"`
 * 가 `28085ea`를 되돌렸다) — `ChatApp`이 `isGlobal`을 계산은커녕
 * `ParticipantList`에 넘기지도 않는다. 단언 1은 그 결함을 정확히 쳐서
 * 실패해야 한다: `ParticipantList.tsx`가 지금도 `hasRoom` 단일 조건만으로
 * 분기하므로(reverted), global이 활성(hasRoom=true)이고 서버가 절대
 * participants를 채우지 않는 상태(ADR-0008)에서 `participants.map(...)`가
 * 빈 배열을 돌며 아무것도 그리지 않는다 — `.pending-note`가 없다. 단언 2는
 * `isGlobal`과 무관한 기존 경로(hasRoom && participants 배열을 그대로
 * map)이므로 지금도 통과해야 한다(회귀 축).
 *
 * `28085ea`를 되살리면(ChatApp이 `isGlobal = chat.activeRoom === GLOBAL_ROOM`을
 * 계산해 `ParticipantList`에 넘기고, `ParticipantList`가 `hasRoom && isGlobal`일
 * 때 `.pending-note`로 이유를 표시하도록 분기) 단언 1이 통과로 전환된다 —
 * 아래 "복원 시 통과 확인" 절 참고.
 */
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM } from '../../src/shared/types';

/**
 * `tests/integration/rq-18-a-global-render.test.ts`와 동일 기법·동일 근거
 * (ADR-0005 결정4 실증): `socket.io-client`의 `io()`에 URL을 주입하고
 * `activeRoom` emit의 실제 서버 ack만 관측(기록)한다. 그 외 모든 emit/ack/
 * 이벤트는 실서버가 그대로 처리한다 — 전송을 목으로 바꾸는 것이 그 계약의
 * "삭제"가 되지 않도록(ADR-0005 결정4 RQ-13-a blocker B-1 교훈) 판정을
 * 대신 내리는 지점만 최소로 관측한다.
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

// useChat(따라서 ChatApp)이 위 vi.mock을 실제로 통해 socket.io-client를 가져오도록
// mock 설정 뒤에 동적 import한다(rq-18-a-global-render.test.ts와 동일 관례).
const { ChatApp } = await import('../../src/client/components/ChatApp');

type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };

/** join emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
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

/** 관찰/발신 전용 raw 클라이언트 소켓(useChat을 거치지 않음). */
function connectRaw(url: string, cleanupFns: Array<() => void | Promise<void>>): ClientSocket {
  const socket = ioClient(url, { forceNew: true });
  cleanupFns.push(() => {
    socket.disconnect();
  });
  return socket;
}

/** 실 서버 왕복(비동기 네트워크 I/O)이 반영될 때까지 폴링한다 — 상한 명시(ADR-0005). */
async function waitForUi(assertion: () => void, timeoutMs = 2000): Promise<void> {
  await waitFor(assertion, { timeout: timeoutMs });
}

/** 사이드바(RoomList, `.col-rooms`)에서 이름이 정확히 일치하는 room-item 버튼을 찾는다. */
function queryRoomItemByName(name: string): HTMLButtonElement | null {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.col-rooms .room-item'));
  return items.find((el) => el.querySelector('.name')?.textContent === name) ?? null;
}

function getRoomItemByName(name: string): HTMLButtonElement {
  const found = queryRoomItemByName(name);
  if (!found) {
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.col-rooms .room-item'));
    const seen = items.map((el) => el.querySelector('.name')?.textContent).join(', ');
    throw new Error(`room-item(name=${name})을 찾을 수 없다 — 현재 사이드바: [${seen}]`);
  }
  return found;
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

/** "+ room 참여" → 이름 입력 → "참여" 제출까지 모달을 통해 room에 참여한다. */
async function joinRoomViaModal(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '+ room 참여' }));
  const input = await screen.findByLabelText('room 이름');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '참여' }));
}

/**
 * 모달로 room에 참여하고, 서버가 join을 승인한 뒤 훅이 보낸 `activeRoom` emit의
 * 실제 ack이 ok:true임을 확인하며, 채팅 헤더가 그 room으로 전환됐음을 확인한다.
 * (rq-13-a-join-rollback.test.ts / rq-18-a-global-render.test.ts와 동일 근거.)
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

/** 이미 목록에 있는 room-item을 클릭해 활성 room으로 전환하고, 서버 activeRoom ack이 ok:true임을 확인한다. */
async function selectRoomAndConfirmAck(name: string): Promise<void> {
  const baseline = fake.activeRoomAcks.length;
  fireEvent.click(getRoomItemByName(name));
  await waitForUi(() => {
    expect(fake.activeRoomAcks.length).toBeGreaterThan(baseline);
  });
  expect(fake.activeRoomAcks[fake.activeRoomAcks.length - 1]).toEqual({ ok: true });
}

beforeEach(() => {
  localStorage.clear();
  fake.activeRoomAcks.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('RQ-15-a / GA-34 배선 축: ChatApp이 global 선택을 실제로 ParticipantList까지 전달하는지 (리뷰어 blocker 폐쇄)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 room 목록에서 global을 실제로 클릭해 활성 room으로 선택하면(서버 ack 확인), 참여자 패널이 빈 칸이 아니라 이유를 보여준다 (RQ-15-a, GA-34 when·then, ChatApp 실렌더 — isGlobal 배선 단언)',
    async () => {
      await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));

      // given: global이 room 목록에 보인다 (RQ-18-a, 이미 GREEN).
      await waitForUi(() => getRoomItemByName(GLOBAL_ROOM));

      // when: user1이 room 목록에서 global을 선택한다 — 클릭 이벤트 → useChat →
      // 실 서버 activeRoom emit → 실 서버 ack(ok:true)까지 전 구간을 실제로
      // 통과시킨다(목으로 ack을 대신 회신하지 않는다, ADR-0005 결정4).
      await selectRoomAndConfirmAck(GLOBAL_ROOM);
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe(`# ${GLOBAL_ROOM}`);
      });

      // then: 참여자 패널은 참여자 "행"이 없다 — global은 참여자 목록을 갖지
      // 않으므로(ADR-0008) 이 자체는 맞다. 참여자가 "누구인가"는 이 테스트가
      // 단언하는 대상이 아니다.
      const body = getParticipantsBody();
      await waitForUi(() => {
        expect(within(body).queryAllByText(/./).length).toBeGreaterThanOrEqual(0); // 마운트 안정화 대기용 no-op 관찰
      });
      expect(body.querySelectorAll('.person').length).toBe(0);

      // then: 그러나 빈 칸이어서는 안 된다 — DESIGN.md :70이 지정한 muted
      // 스타일(.pending-note 재사용)로 "이유"를 담은 노드가 있어야 한다.
      // ★ 이것이 이 세션의 핵심 단언이다 — ChatApp이 isGlobal(또는 동등한
      // 신호)을 실제로 계산해 ParticipantList까지 배선했는지를 실제 사용자
      // 클릭 경로로 검증한다. 정확한 문구는 DESIGN 관할이라 하드코딩하지
      // 않는다(존재 + 비어있지 않음만 확인).
      await waitForUi(() => {
        const reason = getParticipantsBody().querySelector('.pending-note');
        expect(reason).not.toBeNull();
        expect((reason?.textContent ?? '').trim().length).toBeGreaterThan(0);
      });
    },
    10000,
  );

  it(
    'user1이 (2인 이상인) user room을 활성 room으로 선택하면 종전대로 참여자 목록(.person 행)이 렌더된다 (RQ-15-a, GA-34 회귀 축 — 배선 변경이 기존 user room 경로를 깨지 않는지)',
    async () => {
      const url = await startServer(cleanupFns);
      const observer = connectRaw(url, cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));
      await waitForUi(() => getRoomItemByName(GLOBAL_ROOM));

      // given/when: user1이 모달로 user room에 참여해 활성 room으로 만든다.
      await joinRoomAndBecomeActive('room-wire');

      // 서버는 memberCount > 1일 때만 'participants'를 방송한다
      // (src/server/chat/state.ts:148 주석, room.ts:76) — user1 혼자면
      // 방송이 없어 .person 행이 그려질 기회 자체가 없다. 관찰자(observer)를
      // 같은 room에 합류시켜 실제 방송을 유도한다.
      expect((await waitForJoinAck(observer, { room: 'room-wire', nickname: 'observer' })).ok).toBe(true);

      // then: 참여자 패널에 .person 행 2개(user1, observer)가 렌더된다 —
      // isGlobal 배선이 없던 경로(user room)는 그대로 동작해야 한다.
      await waitForUi(() => {
        const body = getParticipantsBody();
        const rows = body.querySelectorAll('.person');
        expect(rows.length).toBe(2);
      });
      const body = getParticipantsBody();
      expect(within(body).getByText('observer')).toBeTruthy();

      // .pending-note가 없어야 한다 — user room은 "빈 칸/이유" 표시 대상이 아니다.
      expect(body.querySelector('.pending-note')).toBeNull();
    },
    10000,
  );
});
