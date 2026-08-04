// @vitest-environment jsdom
/**
 * RQ-18-a / 리뷰 blocker B-1 (_workspace/review/feat-RQ-18-a-global-render.md §2):
 * "`sendMessage`의 동작 변경을 덮는 테스트가 0건이다."
 *
 * ── 배경: 이 PR이 만든 회귀 ──
 * `src/client/useChat.ts`는 `emitWhenIdentified` 로컬 큐를 도입해 `join`과
 * `activeRoom`의 wire emit을 identify/resume ack 이후로 미룬다(GA-31/32/33이
 * 요구하는 서버 세션 필요). 그런데 `sendMessage`는 그 큐를 통과하지 않고
 * `socketRef.current?.emit('message', ...)`를 즉시 호출한다(되돌린 상태 —
 * 조치 커밋 `61582d5`가 `a20c2cc`로 revert됐다. 결함을 실제로 트리에 되살려
 * 정직한 Red를 성립시키기 위해서다, 리뷰 §2 1단계).
 *
 * ── 재현 기전 (리뷰 §1·§2 M-2, 정확한 폐기 지점) ──
 * socket.io-client는 connect 이전에 emit된 패킷을 자체 sendBuffer에 쌓아 뒀다가
 * 연결되는 즉시(사용자 'connect' 리스너가 실행되기 *전*, 내부 emitBuffered()에서)
 * 큐에 쌓인 순서대로 flush한다. `join`·`activeRoom`은 `emitWhenIdentified`로
 * **로컬 JS 배열**(`pendingEmitsRef`)에 갇혀 있다가 identify ack 콜백
 * (connect 리스너 안, 즉 sendBuffer flush보다 나중)에서야 실제 `socket.emit`이
 * 호출된다. 반면 `sendMessage`는 즉시 `socket.emit`을 호출하므로 connect 전에
 * 호출되면 sendBuffer로 들어가 **join/activeRoom보다 먼저** 서버에 도착한다.
 *
 * 서버 `src/server/chat/room.ts`의 `handleMessage`는 두 검사를 순서대로 한다:
 *   1) `:91` `isNonEmptyString(socket.data.nickname)` — **폐기 지점은 항상 여기다.**
 *      `socket.data.nickname`은 identify(`session.ts:180`)·resume(`:283`)·
 *      join(`room.ts:45`)에서만 채워지므로, connect 전에 도착한 message는 이
 *      가드에서 예외 없이 걸린다.
 *   2) `:97` `socket.rooms.has(payload.room)` — global은 `connection.ts:28`이
 *      접속 즉시(1)`socket.join(GLOBAL_ROOM)`하므로 이 검사는 **항상 참**이고
 *      폐기와 무관하다. user room 미참여는 `:97`이 거짓이긴 하나 그 앞 `:91`이
 *      먼저 걸리므로 역시 도달하지 않는다.
 * (이전 라운드의 주석·커밋 메시지가 `:97`을 지목해 리뷰 M-2를 받았다 — 이
 * 파일은 그 정정을 반영해 `:91`만 원인으로 적는다.)
 *
 * ── 두 경로 ──
 * (a) global — RoomList가 매 렌더 무조건 `[GLOBAL_ROOM, ...rooms]`를 합성하므로
 *     서버 왕복 없이 클릭 한 번으로 도달(가장 짧은 경로).
 * (b) user room — "+ room 참여" 모달 제출도 로컬 상태만으로 즉시 렌더되므로
 *     서버 응답을 기다리지 않고 도달할 수 있다(§1의 순서 역전 축 — 이쪽이
 *     회귀의 핵심이라고 리뷰가 특정했다: PR 이전엔 join·message 둘 다
 *     sendBuffer라 FIFO로 순서가 보존됐는데, 이 PR이 join만 로컬 큐로 옮기며
 *     깨졌다).
 *
 * ── 재현 방법: connect 전 한 틱 ──
 * `render()`는 초기 이펙트(소켓 생성 + `io({autoConnect:true})` 호출)까지
 * act()로 동기 플러시하지만, 실제 TCP 접속·엔진 핸드셰이크(connect 이벤트)는
 * 최소 한 틱 뒤다(리뷰 §2). 따라서 `render` 직후 **await 없이** 동기
 * `fireEvent`만으로 room 선택/참여 + 메시지 입력·전송까지 끝내면, 이 함수
 * 호출들이 모두 반환된 시점에도 connect는 아직 일어나지 않았음이 보장된다.
 *
 * ── 단언: 서버 도달 여부 (ADR-0005 결정4) ──
 * 판별 질문 "이 단언이 참이 되려면 서버가 무엇을 답해야 하는가?" — 서버가
 * room.ts:91 가드를 통과시켜 `io.to(room).emit('message', ...)`으로 실제
 * 브로드캐스트해야 한다. `io.to()`는 발신자 자신도 포함하므로(= `socket.to()`가
 * 아님), 서버가 처리했다면 ChatApp 자신의 'message' 리스너가 그 메시지를
 * 받아 화면에 그린다. 전송 계층은 URL 리다이렉트 외 어떤 응답도 창작하지
 * 않는다(아래 vi.mock) — 이 단언이 참이 되려면 실제로 실서버 왕복이 필요하다.
 *
 * ── 골든 아님 ──
 * 이 파일은 새 요구사항이 아니라 이 PR이 만든 회귀를 잠그는 회귀 축이다
 * (`rq-18-a-global-render.test.ts`의 회귀 축 1~3과 같은 위상). `evals/golden/**`에
 * 매핑하지 않는다.
 *
 * ── 자기검증 (test-writer) ──
 * 현재(되돌린) 상태에서 두 테스트 모두 `waitForUi`가 타임아웃하며 실패해야
 * 한다 — sendMessage가 sendBuffer로 직행해 join/activeRoom보다 먼저 도착하고
 * room.ts:91에서 폐기되므로 서버가 echo를 브로드캐스트하지 않는다.
 * `61582d5`(sendMessage를 emitWhenIdentified로 감싸고 room을 호출 시점 값으로
 * 캡처)를 재적용하면, message emit도 join과 같은 로컬 큐를 거쳐 identify ack
 * 이후에만 나가므로 순서가 복원되어 두 테스트 모두 통과해야 한다 — `src/**`를
 * 쓸 수 없는 RED 단계라 직접 재적용해 확인하지 못했다(git이 아직 워킹트리에
 * 갖고 있는 `a20c2cc`의 diff를 되돌리는 것과 동일한 patch다).
 */
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createChatServer } from '../../src/server/createChatServer';
import { GLOBAL_ROOM } from '../../src/shared/types';

/**
 * `socket.io-client`의 `io()`에 테스트 서버 URL을 주입하는 것만 대체한다 —
 * ack·이벤트를 관측·조작하지 않는다(ADR-0005 결정4: "전송 계층만 대체",
 * `tests/integration/rq-18-a-global-render.test.ts`와 동일 골격의 최소판).
 */
const fake = vi.hoisted(() => {
  let url = '';
  return {
    setUrl(u: string): void {
      url = u;
    },
    getUrl(): string {
      return url;
    },
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
      // useChat.ts의 io({...})처럼 URL 없는 호출 — 이 테스트가 지정한 서버로 리다이렉트.
      uri = fake.getUrl();
      opts = (first as Record<string, unknown> | undefined) ?? {};
    }
    return actual.io(uri, { ...opts, forceNew: true });
  }
  return { ...actual, io: ioRedirected };
});

// useChat(따라서 ChatApp)이 위 vi.mock을 실제로 통해 socket.io-client를 가져오도록
// mock 설정 뒤에 동적 import한다(rq-18-a-global-render.test.ts와 동일 관례).
const { ChatApp } = await import('../../src/client/components/ChatApp');

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

/** 사이드바(RoomList, `.col-rooms`)에서 이름이 정확히 일치하는 room-item 버튼을 찾는다.
 *  JoinRoomModal도 `.room-item` 클래스를 재사용하므로 `.col-rooms`로 스코프를 좁힌다. */
function getRoomItemByName(name: string): HTMLButtonElement {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.col-rooms .room-item'));
  const found = items.find((el) => el.querySelector('.name')?.textContent === name);
  if (!found) {
    const seen = items.map((el) => el.querySelector('.name')?.textContent).join(', ');
    throw new Error(`room-item(name=${name})을 찾을 수 없다 — 현재 사이드바: [${seen}]`);
  }
  return found;
}

/** 실 서버 왕복(비동기 네트워크 I/O)이 반영될 때까지 폴링한다 — 상한 명시(ADR-0005). */
async function waitForUi(assertion: () => void, timeoutMs = 2000): Promise<void> {
  await waitFor(assertion, { timeout: timeoutMs });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('RQ-18-a B-1 회귀: connect 이전 emit 순서 역전으로 sendMessage가 유실된다 (골든 아님)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'global: connect 전 한 틱 안에 global 선택 + 메시지 전송을 동기로 끝내면 message가 로컬 큐에 갇힌 activeRoom emit보다 먼저 서버에 도착해 room.ts:91 nickname 가드에서 폐기된다 (RQ-18-a, B-1)',
    async () => {
      await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));

      // when: render 직후, await 없이 동기 fireEvent만으로 global 선택 +
      // 메시지 입력·전송을 끝낸다 — global item은 RoomList가 매 렌더 무조건
      // 합성하는 상시 슬롯(RoomList.tsx:23)이라 서버 왕복 없이 최초 렌더에서
      // 바로 나타난다. 이 블록이 반환되는 시점에도 실 connect는 아직 한 틱
      // 뒤에 있다(리뷰 §2) — sendMessage(현재 결함)는 이 창에서 sendBuffer로
      // 직행한다.
      fireEvent.click(getRoomItemByName(GLOBAL_ROOM));
      fireEvent.change(screen.getByLabelText('메시지 입력'), { target: { value: 'B1-global-race' } });
      fireEvent.click(screen.getByRole('button', { name: '전송' }));

      // then: 서버가 이 메시지를 실제로 처리해 room(global) 멤버(발신자 자신
      // 포함, io.to()) 에게 되돌려 보내야만 화면에 나타난다 — 이 단언이
      // 참이 되려면 서버가 room.ts:91 nickname 가드를 통과해야 한다
      // (ADR-0005 결정4 판별 질문). 결함 상태에서는 서버가 조용히 폐기해
      // 브로드캐스트가 없으므로 타임아웃으로 실패한다.
      await waitForUi(() => {
        expect(screen.getByText('B1-global-race')).toBeTruthy();
      });
    },
    10000,
  );

  it(
    'user room: connect 전 한 틱 안에 room 참여 모달 제출 + 메시지 전송을 동기로 끝내면 message가 로컬 큐에 갇힌 join emit을 추월해 같은 지점(room.ts:91)에서 폐기된다 (RQ-18-a, B-1, 순서 역전 축)',
    async () => {
      await startServer(cleanupFns);
      render(createElement(ChatApp, { nickname: 'user1' }));

      // when: "+ room 참여" 모달도 로컬 상태만으로 즉시 렌더되므로(JoinRoomModal.tsx,
      // 서버 응답 대기 없음) findBy(비동기 폴링) 대신 동기 getBy로 이어간다 —
      // 중간에 await를 넣으면 그 틱에 실 connect가 끼어들 여지가 생겨 경합
      // 재현이 결정론적이지 않게 된다.
      fireEvent.click(screen.getByRole('button', { name: '+ room 참여' }));
      fireEvent.change(screen.getByLabelText('room 이름'), { target: { value: 'room-race' } });
      fireEvent.click(screen.getByRole('button', { name: '참여' }));
      fireEvent.change(screen.getByLabelText('메시지 입력'), { target: { value: 'B1-room-race' } });
      fireEvent.click(screen.getByRole('button', { name: '전송' }));

      // then: PR 이전(main)에는 join도 message도 둘 다 socket.io의 sendBuffer에
      // 쌓여 FIFO로 flush됐으므로 이 시나리오가 항상 성공했다 — 이 PR이 join만
      // 로컬 큐로 옮기며 새로 생긴 회귀다(리뷰 §1). 결함 상태에서는 message가
      // sendBuffer로 직행해 (아직 로컬 큐에 갇혀 나가지도 않은) join을 추월하고
      // room.ts:91에서 폐기되어 타임아웃으로 실패한다.
      await waitForUi(() => {
        expect(screen.getByText('B1-room-race')).toBeTruthy();
      });
    },
    10000,
  );
});
