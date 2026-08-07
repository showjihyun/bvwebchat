// @vitest-environment jsdom
/**
 * RQ-18-a (specs/requirements.md §2-1 RQ-18, "global 포함" 절 — 클라이언트 축):
 * "사용자가 참여 중인 room(global 포함)에 새 메시지가 전달되었을 때 그 room이
 * 그 사용자의 활성 room(ADR-0003 정의)이 아니면, 시스템은 그 room의 안 읽음
 * 개수를 1 증가시켜야 한다. 사용자가 그 room을 활성 room으로 전환하면,
 * 시스템은 그 room의 안 읽음 개수를 0으로 초기화해야 한다."
 *
 * ── 결함 (docs/progress.md RQ-18-a 행, 2026-08-04 실측) ──
 * 서버 축(GA-12~18)은 이미 done — 세션 토큰·resume·활성 room·안 읽음 카운팅
 * 전부 구현·검증됐다. alice 활성=`dev` 상태에서 타 사용자가 global로 보내자
 * `unread` 유니캐스트가 `[{"room":"dev","count":0},{"room":"global","count":1}]`
 * 로 도착했고 `activeRoom={room:'global'}`도 `{"ok":true}`로 수락됐다 — 서버는
 * 스펙이 요구하는 상태를 전부 갖고 있다. 미이행은 **클라이언트가 그것을 그리지
 * 않는다**는 점이다: `src/client/useChat.ts:156`의
 * `res.rooms.filter((r) => r !== GLOBAL_ROOM)`가 global을 참여 room 목록에서
 * 제외하고, `ChatApp`은 그 목록만 `RoomList`에 넘긴다 — UI 어디에도 'global'
 * 문자열이 없다(배포 아티팩트 E2E 실측, 0건).
 *
 * ── 골든 케이스 매핑 (evals/golden/track-a-product.jsonl, spec: RQ-18, status: todo) ──
 * - GA-31: user1 접속(닉네임 확정), 참여 user room 없어도 global이 room 목록
 *   최상단에 표시되고 선택 가능. 나가기·삭제 UI는 없다(ADR-0004가 global의
 *   leave를 거부하므로 그 조작을 노출하면 거짓 어포던스 — DESIGN.md:84
 *   "global은 최상단 고정, 삭제 UI 없음").
 * - GA-32 (2026-08-08 개정 · RQ-04 v1.2 · ADR-0009가 D14를 D14-r로 뒤집음):
 *   활성 room이 room-A(global은 비참여가 아니라 비활성)인 상태에서 user2가
 *   global에 메시지를 보내면 global 항목에 안 읽음 배지 1이 뜨고, room-A
 *   대화에도 그 메시지가 표시되되 출처 칩으로 room-A 원본과 구별된다
 *   (ADR-0009 결정1·4, DESIGN.md:95 "room 안의 global 메시지"). room-A
 *   자체의 안 읽음 배지는 오르지 않는다(ADR-0009 결정5). 옛 "삽입되지
 *   않는다(D14, DESIGN.md:86)" 단언은 폐기 — RQ-04-a GREEN에서 이 케이스만
 *   실패해 모순이 드러났다(evals/golden/track-a-product.jsonl GA-32 note).
 * - GA-33: GA-32 직후, user1이 목록에서 global을 선택하면
 *   `activeRoom={room:'global'}`이 서버에 실제로 수락되고(ok:true) global
 *   배지가 0이 되며 대화 패널이 열려 그 메시지가 보인다.
 *
 * GA-31/32/33 셋 다 "이 단언이 참이 되려면 서버가 무엇을 답해야 하는가?"라는
 * ADR-0005 결정4의 판별 질문에 답이 있다(rooms 브로드캐스트 · unread 유니캐스트 ·
 * activeRoom ack) — 그래서 전송 계층을 목으로 대체하지 않고 실 서버
 * (`createChatServer`) + 실 `socket.io-client`로 검증한다. 유일한 대역은
 * `tests/integration/rq-13-a-join-rollback.test.ts`와 동일하게 `io()`에 테스트
 * 서버 URL을 주입하는 것과, `activeRoom` emit의 실제 ack을 관측(기록만, 응답
 * 조작 없음)하는 것뿐이다 — GA-33이 "서버가 global을 활성 room으로 실제로
 * 받아주는가"를 요구하므로(RQ-13-a의 D1 blocker B-1과 동일한 함정: 목이 그
 * ack을 대신 회신하면 이 계약이 검증에서 사라진다) 그 선례를 그대로 재사용한다.
 * 그 외의 모든 emit/ack/이벤트(identify/join/message/activeRoom 판정 자체)는
 * 실서버가 처리한다.
 *
 * ── 내부 상태 형태를 단언하지 않는다 (GA-31 note) ──
 * GA-28의 given은 "클라이언트의 '참여 room 목록'에는 global이 들어가지 않는다"를
 * 현행 동작으로 적고 있다. 이 파일은 `useChat`의 `rooms` 배열에 global이
 * 들어가는지, 별도 슬롯으로 관리되는지 **묻지 않는다** — 오직 관찰 가능한 표면
 * (room 목록에 'global' 텍스트가 보이는가 · 클릭 가능한가 · 배지가 뜨는가 ·
 * 선택하면 0이 되는가)만 단언한다. 그래서 이 파일은 `renderHook`이 아니라
 * `render(<ChatApp .../>)`로 실제 DOM을 그려 `RoomList`/`ChatPane`의 렌더
 * 결과를 직접 확인한다(rq-13-a는 훅 상태만 확인했지만, GA-31~33의 `then`은
 * 화면 표시 자체를 요구하므로 이 파일에서는 컴포넌트 렌더가 필수다).
 *
 * ── 회귀 축 (골든 아님 — "필터만 지우고 통과"를 막는 잠금) ──
 * docs/progress.md RQ-18-a 행이 미리 경고한 위험: "필터만 지우면 global이
 * '멤버 0이면 삭제' 경로(RQ-12)에 걸릴 수 있다." 세 축을 이 파일에 함께 고정한다:
 *   1) RQ-12 — global은 마지막 참여자가 떠나도 삭제되지 않는다(ADR-0004 예외
 *      게이팅, 기존 GA-27 서버 축 재확인). user room은 그대로 삭제된다(GA-26).
 *   2) RQ-13 — rooms 브로드캐스트의 0번은 항상 global이고, user room은 멤버
 *      ≥1인 것만 생성순으로 온다(기존 GA-21 서버 축 재확인).
 *   3) RQ-02/RQ-18 격리 — 미참여 user room의 메시지는 사이드바·배지 어디에도
 *      나타나지 않는다(GA-15가 서버 축을 이미 덮으므로, 이 축은 클라 축이 그
 *      서버 계약을 깨지 않는지를 렌더 결과로 확인한다).
 * 1)·2)는 순수 서버 계약이라 raw socket으로 검증한다(이 파일의 클라이언트
 * 변경과 무관하게 항상 참이어야 한다). 3)은 렌더 결과를 직접 확인해야 의미가
 * 있으므로 `ChatApp`을 렌더한다.
 *
 * ── 자기검증 메모 (test-writer) ──
 * GA-31/32/33은 `src/client/useChat.ts:156`의 필터가 살아있는 현재 상태에서
 * `getRoomItemByName(GLOBAL_ROOM)`이 room-item을 찾지 못해 throw하며 반드시
 * 실패한다(현재 UI에 'global' 텍스트가 0건이므로). 회귀 축 1)·2)는 서버가 이미
 * 구현한 기존 계약을 raw socket으로 재확인하는 것이라 현재도 통과해야 하고,
 * 3)은 애초에 미참여 room이 안 보이는 것이 현재 동작(버그가 아님)이라 역시
 * 현재도 통과해야 한다.
 */
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM } from '../../src/shared/types';

/**
 * `socket.io-client`의 `io()`에 URL을 주입하고 `activeRoom` emit의 실제 서버
 * ack만 관측(기록)한다. `tests/integration/rq-13-a-join-rollback.test.ts`와
 * 동일 기법·동일 근거(ADR-0005 결정4 실증) — GA-33이 "서버가 global을 활성
 * room으로 실제로 받아주는가"를 요구하므로 그 ack을 목이 대신 회신하면 계약이
 * 검증에서 사라진다. 그 외 모든 emit/ack/이벤트는 실서버가 그대로 처리한다.
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
// mock 설정 뒤에 동적 import한다(rq-13-a-join-rollback.test.ts와 동일 관례).
const { ChatApp } = await import('../../src/client/components/ChatApp');

type IdentifyAck = { ok: true; nickname: string; token: string } | { ok: false; error: string };
type JoinAck = { ok: true; history: unknown[] } | { ok: false; error: string };
type LeaveAck = { ok: true } | { ok: false; error: string };
interface RoomsPayload {
  rooms: string[];
}

/** identify emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005). */
function waitForIdentifyAck(
  socket: ClientSocket,
  payload: { nickname: string },
  timeoutMs = 2000,
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

/** 접속 직후 서버가 유니캐스트로 보내는 첫 'rooms' 스냅샷을 기다린다(RQ-13 신규 접속자 초기 전달 계약). */
function waitForRoomsSnapshot(socket: ClientSocket, timeoutMs = 2000): Promise<RoomsPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`'rooms' 스냅샷이 ${timeoutMs}ms 내에 도착하지 않았다`));
    }, timeoutMs);
    socket.once('rooms', (payload: RoomsPayload) => {
      clearTimeout(timer);
      resolve(payload);
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

/** 관찰/발신 전용 raw 클라이언트 소켓(useChat을 거치지 않음) — 기존 통합 테스트의 connectClient와 동일 역할. */
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

/** 사이드바(RoomList, `.col-rooms`)에서 이름이 정확히 일치하는 room-item 버튼을 찾는다.
 *  JoinRoomModal도 `.room-item` 클래스를 재사용하므로 `.col-rooms`로 스코프를 좁힌다. */
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
 * (`rq-13-a-join-rollback.test.ts`의 D1 잠금과 동일 근거 — 낙관적 헤더 전환만
 * 보고 다음 단계로 넘어가면 서버가 아직 그 room을 활성으로 인지하기 전일 수 있다.)
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

describe('RQ-18-a / GA-31: global이 참여 user room 없이도 목록 최상단에 표시되고 선택 가능하며 나가기·삭제 UI가 없다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    "user1이 접속해 닉네임이 확정된 상태에서 참여한 user room이 하나도 없어도 global이 보이고, 클릭하면 서버가 활성 room으로 수락하며, user room을 추가해도 global은 여전히 최상단이다 (RQ-18, GA-31)",
    async () => {
      await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));

      // then: 참여한 user room이 하나도 없어도 global이 보인다.
      await waitForUi(() => getRoomItemByName(GLOBAL_ROOM));
      const globalItem = getRoomItemByName(GLOBAL_ROOM);
      expect(globalItem.tagName).toBe('BUTTON');

      // then: 나가기·삭제 UI가 없다 (DESIGN.md:84 "global은 최상단 고정, 삭제 UI 없음").
      expect(within(globalItem).queryAllByRole('button')).toHaveLength(0);
      expect(globalItem.textContent ?? '').not.toMatch(/나가기|삭제|leave|delete/i);

      // then: 선택 가능 — 클릭하면 단순 로컬 상태 변경이 아니라 서버가 실제로
      // 활성 room으로 수락한다(activeRoom emit의 실제 ack이 ok:true).
      await selectRoomAndConfirmAck(GLOBAL_ROOM);
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe(`# ${GLOBAL_ROOM}`);
      });

      // then: user room을 하나 추가해도 global은 여전히 목록 0번째(최상단)다.
      await joinRoomAndBecomeActive('room-after-global');
      await waitForUi(() => {
        const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.col-rooms .room-item'));
        expect(items.length).toBeGreaterThanOrEqual(2);
        expect(items[0].querySelector('.name')?.textContent).toBe(GLOBAL_ROOM);
      });
    },
    10000,
  );
});

describe('RQ-18-a / GA-32: 비활성 global에 도착한 메시지는 배지로 알리고, 활성 대화(room-A)에도 출처 칩과 함께 표시된다(room-A 자체 안 읽음은 그대로)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1의 활성 room이 room-A(global은 자동 참여 중이지만 비활성)인 상태에서 user2가 global에 메시지를 보내면 global 항목에 안 읽음 배지 1이 뜨고, room-A 대화에도 그 메시지가 출처 칩과 함께 표시되며, room-A 자체의 안 읽음은 오르지 않는다 (RQ-18, GA-32)',
    async () => {
      const url = await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));
      await waitForUi(() => getRoomItemByName(GLOBAL_ROOM));

      // given: room-A에 참여해 활성 room으로 만든다(global은 여전히 소켓
      // 레벨로 자동 참여 중이지만 세션의 활성 room은 room-A).
      await joinRoomAndBecomeActive('room-A');

      // when: user2가 global에 메시지를 보낸다(발신 전용 — join은 예약 이름
      // 'global'을 거부하므로 identify로 nickname만 확보한다, 기존 GA-16과 동일 근거).
      const user2 = connectRaw(url, cleanupFns);
      const identifyAck2 = await waitForIdentifyAck(user2, { nickname: 'user2' });
      if (!identifyAck2.ok) throw new Error(`user2 identify 실패: ${identifyAck2.error}`);
      user2.emit('message', { room: GLOBAL_ROOM, body: 'GA32-unread-body' });

      // then(축1): global 항목에 안 읽음 배지 1이 뜬다.
      await waitForUi(() => {
        const item = getRoomItemByName(GLOBAL_ROOM);
        expect(within(item).getByText('1')).toBeTruthy();
      });

      // then(축2 — 이 케이스의 존재 이유, 클라 렌더 축): room-A(현재 활성)
      // 대화에도 그 메시지가 표시된다(D14-r · RQ-04 v1.2 · ADR-0009 결정1) —
      // room-A 원본과 구별하는 출처 칩이 붙는다(결정4, DESIGN.md:95 "room 안의
      // global 메시지"). payload에 구분 정보가 실제로 실리는지(서버 계약
      // 수준)는 GA-41이 이미 덮으므로, 여기서는 그 값이 화면에 실제로
      // 그려지는지만 확인한다(GA-32 note: 서버가 유니캐스트를 보내는 것과
      // 클라가 그것을 그리는 것은 다른 실패 지점).
      await waitForUi(() => {
        expect(screen.getByText('GA32-unread-body')).toBeTruthy();
      });
      const msgRow = screen.getByText('GA32-unread-body').closest('.msg-row');
      if (!msgRow) {
        throw new Error("'GA32-unread-body'를 담은 .msg-row를 찾을 수 없다");
      }
      expect(within(msgRow as HTMLElement).getByText('# global')).toBeTruthy();
      expect(getChatHeaderText()).toBe('# room-A');

      // then(축3): room-A 자체의 안 읽음 배지는 오르지 않는다(ADR-0009 결정5:
      // "안 읽음은 #global만 올린다"). room-A가 활성인 동안은 RoomList가 활성
      // room의 배지를 항상 숨기므로(hasUnread = unread>0 && room!==activeRoom,
      // RoomList.tsx:34) 활성 상태에서 배지가 안 보이는 것만으로는 "실제로
      // 0"과 "활성이라 숨겨졌을 뿐"을 구분할 수 없다 — 부정 단언이 무의미하게
      // 통과하는 함정(GA-40 설계 메모와 동일 근거). 그래서 global로 활성을
      // 전환해 room-A를 비활성으로 만든 뒤에도 배지가 없는지로 판정한다:
      // 서버가 결정5를 어기고 room-A에도 unread를 올렸다면 이 시점에 '1'이
      // 드러난다.
      await selectRoomAndConfirmAck(GLOBAL_ROOM);
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe(`# ${GLOBAL_ROOM}`);
      });
      expect(within(getRoomItemByName('room-A')).queryByText('1')).toBeNull();
    },
    10000,
  );
});

describe('RQ-18-a / GA-33: global을 선택하면 서버 activeRoom ack이 ok:true이고 배지가 0이 되며 대화가 보인다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'GA-32 직후(global 배지=1, 활성 room은 room-A) 상태에서 user1이 room 목록에서 global을 선택하면 activeRoom emit의 실제 서버 ack이 ok:true이고, global 배지가 0이 되며, 대화 패널에 그 메시지가 보인다 (RQ-18, GA-33)',
    async () => {
      const url = await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));
      await waitForUi(() => getRoomItemByName(GLOBAL_ROOM));

      // given: GA-32와 동일 — room-A 활성, global에 안 읽음 1.
      await joinRoomAndBecomeActive('room-A');
      const user2 = connectRaw(url, cleanupFns);
      const identifyAck2 = await waitForIdentifyAck(user2, { nickname: 'user2' });
      if (!identifyAck2.ok) throw new Error(`user2 identify 실패: ${identifyAck2.error}`);
      user2.emit('message', { room: GLOBAL_ROOM, body: 'GA33-body' });
      await waitForUi(() => {
        expect(within(getRoomItemByName(GLOBAL_ROOM)).getByText('1')).toBeTruthy();
      });

      // when: user1이 room 목록에서 global을 선택한다 — 서버 ack을 직접
      // 관측한다(ADR-0005 결정4 실증: 목이 이 ack을 대신 회신하면 "서버가
      // global을 활성 room으로 받아준다"는 계약이 검증에서 사라진다).
      await selectRoomAndConfirmAck(GLOBAL_ROOM);

      // then: 대화 패널이 열려 그 메시지가 보인다.
      await waitForUi(() => {
        expect(getChatHeaderText()).toBe(`# ${GLOBAL_ROOM}`);
      });
      await screen.findByText('GA33-body');

      // then: 배지가 0이 된다(전달) — RoomList는 활성 room의 배지를 항상
      // 숨기므로(hasUnread = unread>0 && room!==activeRoom), 이 부재만으로는
      // "로컬 낙관적 처리"와 "서버가 실제로 0을 회신"을 구분할 수 없다. 위
      // selectRoomAndConfirmAck에서 이미 activeRoom ack 자체가 ok:true임을
      // 직접 확인했으므로(서버가 그 요청을 실제로 처리했다는 증거), 여기서는
      // 배지가 사라졌다는 관찰 가능한 결과만 추가로 고정한다.
      expect(within(getRoomItemByName(GLOBAL_ROOM)).queryByText('1')).toBeNull();
    },
    10000,
  );
});

describe('RQ-18-a 회귀축 1 (RQ-12): global 상시 노출 변경이 room 생성·삭제 수명주기를 깨지 않는다 (골든 아님)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('user room은 마지막 참여자가 떠나면 rooms 목록에서 사라지고, global은 항상 남는다 (RQ-12 회귀, 기존 GA-26/27 서버 축 재확인)', async () => {
    const url = await startServer(cleanupFns);
    const creator = connectRaw(url, cleanupFns);
    expect((await waitForJoinAck(creator, { room: 'room-reg12', nickname: 'creator' })).ok).toBe(true);

    // 참여 직후 관찰자가 받는 스냅샷: global이 0번, room-reg12가 뒤따른다.
    const observerBefore = connectRaw(url, cleanupFns);
    const before = await waitForRoomsSnapshot(observerBefore);
    expect(before.rooms).toEqual([GLOBAL_ROOM, 'room-reg12']);

    // when: 마지막(유일한) 참여자가 room-reg12를 떠난다.
    expect((await waitForLeaveAck(creator, { room: 'room-reg12' })).ok).toBe(true);

    // then: 새 관찰자는 room-reg12가 빠지고 global만 남은 스냅샷을 받는다
    // (ADR-0004 예외 게이팅 — global은 이 삭제 경로에서 제외된다).
    const observerAfter = connectRaw(url, cleanupFns);
    const after = await waitForRoomsSnapshot(observerAfter);
    expect(after.rooms).toEqual([GLOBAL_ROOM]);
  });
});

describe('RQ-18-a 회귀축 2 (RQ-13): rooms 브로드캐스트의 global 고정 위치·생성순 정렬은 유지된다 (골든 아님)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it('global은 항상 0번 인덱스, user room은 멤버 ≥1인 것만 생성순으로 뒤따른다 (RQ-13 회귀, 기존 GA-21 서버 축 재확인)', async () => {
    const url = await startServer(cleanupFns);
    const c1 = connectRaw(url, cleanupFns);
    const c2 = connectRaw(url, cleanupFns);
    expect((await waitForJoinAck(c1, { room: 'room-first', nickname: 'c1' })).ok).toBe(true);
    expect((await waitForJoinAck(c2, { room: 'room-second', nickname: 'c2' })).ok).toBe(true);

    const observer = connectRaw(url, cleanupFns);
    const snapshot = await waitForRoomsSnapshot(observer);
    expect(snapshot.rooms).toEqual([GLOBAL_ROOM, 'room-first', 'room-second']);
  });
});

describe('RQ-18-a 회귀축 3 (RQ-02/RQ-18 격리): 미참여 room의 메시지는 사이드바·배지 어디에도 나타나지 않는다 (골든 아님)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 참여하지 않은 room-iso에 메시지가 도착해도 사이드바에 그 room이나 안 읽음이 생기지 않는다 (GA-15 클라 축, RQ-02/RQ-18 회귀)',
    async () => {
      const url = await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));
      // 마운트·연결 준비 신호로 GA-31~33처럼 global room-item을 기다리지
      // 않는다 — 이 축은 정확히 "global이 아직 안 보이는" 결함과 무관하게
      // 항상 참이어야 하므로, 그 결함에 우연히 걸려 잘못된 이유로 실패하면
      // 안 된다(현재 상태에서도 통과해야 하는 회귀축이다). 항상 렌더되는
      // "+ room 참여" 버튼으로 마운트를 확인한다.
      await screen.findByRole('button', { name: '+ room 참여' });

      const user2 = connectRaw(url, cleanupFns);
      expect((await waitForJoinAck(user2, { room: 'room-iso', nickname: 'user2' })).ok).toBe(true);
      user2.emit('message', { room: 'room-iso', body: 'no-one-should-see-this' });

      // 부정 단언(ADR-0005): 무한 대기가 아니라 짧은 상한 내 관찰로 확인한다.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(queryRoomItemByName('room-iso')).toBeNull();
      expect(screen.queryByText('no-one-should-see-this')).toBeNull();
    },
    10000,
  );
});
