import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatServer } from '../../src/server/createChatServer';
import type { ChatMessage } from '../../src/shared/types';

/**
 * RQ-10 (specs/requirements.md §2):
 * "사용자가 접속하면, 시스템은 닉네임 입력만으로 사용자를 식별해야 한다
 * (계정·비밀번호 없음). 이미 사용 중인 닉네임이 입력되면, 시스템은 자동
 * 접미사를 붙여 고유한 닉네임을 부여해야 한다. 같은 브라우저에서
 * 새로고침하면, 시스템은 동일 사용자로 인식하고 참여 중이던 room을
 * 복원해야 한다 (서버 프로세스가 유지되는 동안)."
 *
 * 이 파일이 다루는 골든 케이스 (evals/golden/track-a-product.jsonl, spec: RQ-10):
 *   GA-09
 *     given: 닉네임 미입력(무명) 사용자
 *     when : room 참여 시도
 *     then : 닉네임 입력 전에는 참여 불가, 닉네임 입력만으로 참여 허용
 *            (계정·비밀번호 불요)
 *   GA-11
 *     given: user1이 닉네임 alice로 접속 중
 *     when : 다른 브라우저에서 alice로 접속 시도
 *     then : 두 번째 사용자는 자동 접미사가 붙은 고유 닉네임(예: alice-2)을
 *            부여받음
 *
 * ── 스코프 경계 (이 파일이 검증하지 않는 것) ──
 * RQ-10 세 번째 문장("같은 브라우저에서 새로고침하면 동일 사용자로 인식하고
 * room을 복원")과 ADR-0003의 서버 발급 세션 토큰·30초 퇴장 유예·활성 room은
 * 이 RQ의 스코프 밖이다 — 골든 케이스가 없고(GA-09/11만 이 RQ에 매핑됨),
 * 클라이언트 재접속 로직까지 필요한 별도 후속 작업이다. 이 파일은 오직
 * "닉네임 식별 + 자동 고유화"(GA-09/11)만 검증한다.
 *
 * ── 서버 계약 (기존, RQ-01/02/03/04에서 이미 구현됨 — 변경하지 않음) ──
 * src/server/createChatServer.ts:
 *   join({room,nickname}, ack) → 해당 소켓을 room 수신자 목록에 추가하고
 *     socket.data.nickname을 자칭 그대로(고유성 검사 없이) 연결한다.
 *     payload.room·payload.nickname이 비어있으면 ack({ok:false,error:...}).
 *   message({room,body}) → socket.data.nickname을 조회해 room 멤버 전원에게
 *     'message'(ChatMessage) 브로드캐스트.
 *   leave({room}, ack) → 해당 소켓을 room 수신자 목록에서 제거.
 *
 * ── 서버 계약 — 신설 (이 테스트가 정의한다, 아직 미구현, coder의 구현 대상) ──
 *
 * identify(payload: { nickname: string }, ack: (result: IdentifyAck) => void)
 *   IdentifyAck = { ok: true; nickname: string } | { ok: false; error: string }
 *
 *   - payload.nickname이 비어있는 문자열(또는 공백만)이면 ack({ok:false,
 *     error:...}) — "닉네임 입력 전에는 참여 불가"(GA-09).
 *   - payload.nickname이 비어있지 않으면: 서버가 (인메모리로) 현재 접속 중인
 *     다른 소켓이 이미 그 닉네임을 사용 중인지 확인한다.
 *       · 사용 중이 아니면: 입력한 닉네임 그대로 ack({ok:true, nickname:
 *         payload.nickname}) — "닉네임 입력만으로 참여 허용, 계정·비밀번호
 *         불요"(GA-09). payload에 nickname 외 다른 필드가 없다는 것 자체가
 *         "계정·비밀번호 불요"를 구조적으로 증명한다.
 *       · 이미 다른 소켓이 사용 중이면: 자동 접미사를 붙인 고유 닉네임을
 *         생성해 ack({ok:true, nickname: 고유화된값}) — GA-11.
 *
 * ── 설계 결정: 왜 별도 identify 이벤트인가 (join을 직접 수정하지 않는 이유) ──
 * 후보 (a) 별도 identify 이벤트 vs (b) 기존 join에 고유화 로직 추가 — (b)를
 * 배제한 이유: join은 같은 소켓이 여러 room에 각각 참여할 때마다 호출된다
 * (RQ-02 GA-06: 동일 사용자가 room-A·room-B에 각각 join하며 매번 같은
 * nickname을 재전송한다). join 안에 "이미 사용 중인 닉네임이면 고유화"
 * 로직을 넣으면, 같은 소켓이 두 번째 room에 참여할 때 "자기 자신이 이미
 * 등록한 닉네임"을 "타인이 사용 중"으로 오판해 두 번째 join에서 엉뚱하게
 * 접미사가 붙는 회귀를 만들 위험이 있다(이를 피하려면 "이미 이 소켓에
 * 등록된 닉네임과 동일하면 통과"라는 예외 처리가 필요한데, 이는 join의
 * 책임 범위를 넘어선다). 반면 접속 후 최초 1회만 호출되는 별도 identify
 * 이벤트는 이 문제가 구조적으로 없다. 또한 ADR-0003이 식별을 "최초 접속
 * 시" 이뤄지는 별도 단계로 규정하므로(향후 세션 토큰 발급도 이 단계에
 * 자연스럽게 연결된다), 별도 이벤트가 향후 확장과도 정합적이다.
 *
 * identify와 기존 join의 관계는 이 RQ에서 **의도적으로 느슨하게** 둔다 —
 * join은 여전히 자신의 payload.nickname을 그대로 신뢰한다(변경 없음).
 * "identify로 부여받은 닉네임을 이후 join이 강제로 사용해야 한다"는 통합은
 * 세션 토큰(ADR-0003)이 도입되는 후속 RQ의 몫이다. 이 파일의 GA-09/11
 * 테스트는 identify로 얻은 닉네임을 join에 "관례적으로" 재사용해(클라이언트가
 * 그렇게 협조한다고 가정) 그 닉네임이 실제 room 참여에도 유효함을 양성
 * 대조로 보여주지만, 서버가 그 일치를 강제하는지는 검증하지 않는다.
 *
 * ── GA-11 접미사 형식에 대한 판단 ──
 * 골든 케이스 원문은 "예: alice-2"로 예시를 들었을 뿐 형식을 강제하지
 * 않는다. 따라서 이 테스트는 정확히 'alice-2'라는 문자열을 단언하지 않고,
 * "alice와 다르면서 alice로 시작하는(식별 가능한 파생) 값"을 단언한다 —
 * 접미사 구분자(-, _, # 등)나 카운터 시작 값을 이 세션이 임의로 확정해
 * coder의 선택지를 부당하게 좁히지 않기 위함이다.
 *
 * 부정 단언 공통 원칙(ADR-0005)은 이 파일에서 사용하지 않는다 — GA-09/11
 * 모두 "특정 값이 도착/부여됨"을 확인하는 양성 단언으로 충분히 검증된다.
 */

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

/** RQ-10 신설 계약: identify ack shape (파일 상단 주석 참고). */
type IdentifyAck = { ok: true; nickname: string } | { ok: false; error: string };

/**
 * identify emit 후 ack 콜백을 timeoutMs 내에 기다린다 — 상한 명시(ADR-0005).
 * RQ-10 신설 계약: 'identify' 핸들러가 아직 없으므로(정상 Red) 서버가 ack를
 * 회신하지 않아 이 대기가 timeoutMs 후 reject된다.
 */
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

describe('RQ-10 / GA-09: 닉네임 미입력 사용자는 참여 불가, 닉네임 입력만으로 참여 허용(계정·비밀번호 불요)', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    '닉네임 없이 identify를 시도하면 거부되고, 닉네임을 입력하면 identify와 room 참여가 모두 허용된다 (RQ-10, GA-09)',
    async () => {
      const url = await startServer(cleanupFns);
      const anonymous = connectClient(url, cleanupFns);

      // given: 닉네임 미입력(무명) 사용자
      // when: room 참여 시도(닉네임 없이 identify) → then: 참여 불가(거부)
      const emptyAck = await waitForIdentifyAck(anonymous, { nickname: '' });
      expect(emptyAck.ok).toBe(false);

      // when: 닉네임을 입력해 identify 시도. payload는 { nickname } 단일
      // 필드뿐이다 — 계정/비밀번호 필드가 애초에 존재하지 않는다는 것 자체가
      // "계정·비밀번호 불요"를 구조적으로 증명한다.
      const namedAck = await waitForIdentifyAck(anonymous, { nickname: 'newbie' });
      if (namedAck.ok === false) {
        throw new Error(`identify 실패: ${namedAck.error}`);
      }
      // then: 닉네임 입력만으로 참여 허용 — 충돌이 없으므로 입력값 그대로 부여.
      expect(namedAck.nickname).toBe('newbie');

      // then(양성 대조): 부여받은 닉네임으로 실제 room 참여(기존 join 계약,
      // 변경 없음)가 성공한다 — "참여 허용"이 ack 문자열로만 그치지 않고
      // 실제 참여로 이어짐을 증명한다.
      const joinAck = await waitForJoinAck(anonymous, { room: 'room-A', nickname: namedAck.nickname });
      expect(joinAck.ok).toBe(true);

      // 회귀 방지: 기존 join 계약은 이미 빈 nickname을 별도로 거부한다
      // (RQ-01 handleJoin, 기존 구현) — identify 없이 join만 직접 시도해도
      // "닉네임 입력 전에는 참여 불가"가 성립함을 함께 확인한다.
      const directJoinWithoutNickname = await waitForJoinAck(anonymous, { room: 'room-B', nickname: '' });
      expect(directJoinWithoutNickname.ok).toBe(false);
    }
  );

  it('identify 이후 join payload의 nickname으로 발신 신원을 바꿀 수 없다', async () => {
    const url = await startServer(cleanupFns);
    const alice = connectClient(url, cleanupFns);
    const bob = connectClient(url, cleanupFns);

    const aliceIdentity = await waitForIdentifyAck(alice, { nickname: 'alice' });
    const bobIdentity = await waitForIdentifyAck(bob, { nickname: 'bob' });
    if (!aliceIdentity.ok || !bobIdentity.ok) throw new Error('identify failed');

    expect((await waitForJoinAck(alice, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);
    expect((await waitForJoinAck(bob, { room: 'room-A', nickname: 'alice' })).ok).toBe(true);

    const received = waitForEvent<ChatMessage>(alice, 'message');
    bob.emit('message', { room: 'room-A', body: 'identity is server-owned' });
    await expect(received).resolves.toEqual({
      room: 'room-A',
      nickname: 'bob',
      body: 'identity is server-owned',
    });
  });
});

describe('RQ-10 / GA-11: 이미 사용 중인 닉네임은 자동 접미사로 고유화된다', () => {
  const cleanupFns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it(
    'user1이 alice로 접속 중일 때 다른 소켓(다른 브라우저를 모사)이 alice로 identify를 시도하면 자동 접미사가 붙은 고유 닉네임을 부여받는다 (RQ-10, GA-11)',
    async () => {
      const url = await startServer(cleanupFns);
      const user1 = connectClient(url, cleanupFns); // "user1이 닉네임 alice로 접속 중"
      const user2 = connectClient(url, cleanupFns); // "다른 브라우저에서 alice로 접속 시도" — 별도 소켓으로 모사

      // given: user1이 먼저 alice로 identify → 충돌이 없으므로 그대로 부여받는다.
      const firstAck = await waitForIdentifyAck(user1, { nickname: 'alice' });
      if (firstAck.ok === false) {
        throw new Error(`user1 identify 실패: ${firstAck.error}`);
      }
      expect(firstAck.nickname).toBe('alice');

      // when: user2(다른 브라우저)가 동일 닉네임 alice로 identify 시도
      const secondAck = await waitForIdentifyAck(user2, { nickname: 'alice' });
      if (secondAck.ok === false) {
        throw new Error(`user2 identify 실패: ${secondAck.error}`);
      }

      // then: 두 번째 사용자는 자동 접미사가 붙은 고유 닉네임을 부여받는다.
      // 정확한 구분자·카운터 형식은 스펙이 강제하지 않으므로(원문은 "예:
      // alice-2") "alice와 다르면서 alice로부터 식별 가능하게 파생된 값"으로
      // 유연하게 단언한다 (파일 상단 주석 "GA-11 접미사 형식에 대한 판단" 참고).
      expect(secondAck.nickname).not.toBe('alice');
      expect(secondAck.nickname.startsWith('alice')).toBe(true);
      expect(secondAck.nickname.length).toBeGreaterThan('alice'.length);

      // then(양성 대조): 두 소켓이 각자 부여받은 닉네임으로 실제 room
      // 참여(기존 join 계약)와 메시지 발신이 모두 정상 동작하고, 서로 다른
      // nickname으로 정확히 태그됨을 확인한다 — "부여받은 닉네임"이 ack
      // 문자열로만 존재하는 게 아니라 실제 채팅 흐름에서도 유효함을 증명한다.
      expect((await waitForJoinAck(user1, { room: 'room-A', nickname: firstAck.nickname })).ok).toBe(true);
      expect((await waitForJoinAck(user2, { room: 'room-A', nickname: secondAck.nickname })).ok).toBe(true);

      const receivedFromUser1 = waitForEvent<ChatMessage>(user2, 'message');
      user1.emit('message', { room: 'room-A', body: 'hi from alice' });
      const expectedFromUser1: ChatMessage = { room: 'room-A', nickname: 'alice', body: 'hi from alice' };
      await expect(receivedFromUser1).resolves.toEqual(expectedFromUser1);

      const receivedFromUser2 = waitForEvent<ChatMessage>(user1, 'message');
      user2.emit('message', { room: 'room-A', body: 'hi from the second alice' });
      const expectedFromUser2: ChatMessage = {
        room: 'room-A',
        nickname: secondAck.nickname,
        body: 'hi from the second alice',
      };
      await expect(receivedFromUser2).resolves.toEqual(expectedFromUser2);
    }
  );
});
