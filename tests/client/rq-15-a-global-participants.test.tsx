// @vitest-environment jsdom
/**
 * RQ-15-a / GA-34 (evals/golden/track-a-product.jsonl 마지막 줄):
 * given: user1이 접속해 room 목록에 global이 보이는 상태(RQ-18-a). global은
 *        ADR-0008에 따라 참여자 목록을 갖지 않는다.
 * when : user1이 global을 활성 room으로 선택한다.
 * then : 참여자 패널이 빈 칸이 아니라 '참여자 목록이 없다'는 것과 그 이유를
 *        표시한다. user room을 선택하면 종전대로 참여자 목록이 나온다.
 *
 * 근거 문서:
 * - docs/adr/0008-global-participants.md "결정"/"결과" 절 — global은 참여자
 *   목록을 갖지 않는다. 클라이언트는 global이 활성일 때 빈 칸을 두지 않고
 *   이유를 표시한다.
 * - docs/design/DESIGN.md :66-71 — 참여자 패널은 상시 노출, global 활성 시
 *   목록 대신 이유를 muted 본문 스타일(`.pending-note` 재사용)로 조용히 표시.
 *
 * 테스트 레벨 판단 (ADR-0005 결정4 판별 질문 — "이 단언이 참이 되려면 서버가
 * 무엇을 답해야 하는가?"): 답 없음. global에 참여자 목록이 없다는 사실 자체는
 * ADR-0008이 이미 정했고, 그 자리에 UI가 무엇을 그리는가는 순수 렌더다. 서버는
 * 이 경로에 아무것도 보내지 않는다. 그러므로 tests/client/ (참고 형태:
 * tests/client/entry-screen.test.tsx — 순수 렌더 테스트).
 *
 * 이 테스트가 증명하지 않는 것 (GA-34 note 그대로): global의 실제 참여자가
 * 누구인가. ADR-0008이 그 범위를 명시적으로 밖에 뒀다 — 아래에서는 항상
 * `participants: []`로만 global 상태를 표현하고, 그 배열의 "내용"에 대해서는
 * 아무것도 단언하지 않는다. 정확한 안내 문구의 글자 그대로도 단언하지 않는다
 * (문구는 DESIGN 관할이라 바뀔 수 있다) — "빈 칸이 아니다"와 "이유를 담는
 * 노드가 있다"만 잡는다.
 *
 * 인터페이스 메모 (GREEN 구현자에게): 현재 `ParticipantList` Props는
 * `{ nickname, hasRoom, participants }` 뿐이라 "활성 room이 global인가"를
 * 표현할 수 없다. `hasRoom=true && participants=[]`는 지금도 나올 수 있는 값이라
 * (참여자 데이터 도착 전 과도기 등) 그것만으로 global을 특정할 수 없으므로,
 * 참여자 배열이 비어있다는 사실 자체를 신호로 쓰지 않는다. 이 테스트는 GREEN이
 * 추가해야 할 새 prop `isGlobal: boolean`을 전제한다 (RoomList가 이미 쓰는
 * activeRoom === GLOBAL_ROOM 비교와 같은 결의 신호를 ChatApp이 계산해 내려주는
 * 형태). 아직 타입에 없는 prop이므로 렌더 헬퍼에서 캐스팅으로 감싸
 * `tsc --noEmit`이 "테스트 파일 자체의 타입 오류"(ADR-0005 결정3, 부적격)를
 * 내지 않게 격리했다 — 이 캐스팅 자체가 "여기 새 prop이 필요하다"는 계약을
 * 문서화한다. prop 이름이 달라도 무방하지만, GREEN 구현이 이 이름을 쓰지
 * 않으면 이 테스트는 여전히(정당하게) 실패한다.
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ParticipantList } from '../../src/client/components/ParticipantList';

type CurrentProps = ComponentProps<typeof ParticipantList>;
type NextProps = CurrentProps & { isGlobal: boolean };

function renderParticipantList(props: NextProps) {
  return render(<ParticipantList {...(props as unknown as CurrentProps)} />);
}

afterEach(() => {
  cleanup();
});

describe('RQ-15-a / GA-34: 참여자 패널 — global vs user room', () => {
  it('GA-34 단언1: global이 활성일 때 참여자 패널은 빈 칸이 아니라 이유를 보여준다 (ADR-0008)', () => {
    renderParticipantList({
      nickname: 'user1',
      hasRoom: true,
      isGlobal: true,
      // ADR-0008: 서버가 global에 대해 절대 participants를 채우지 않는다.
      // 이 배열의 "내용"은 이 테스트가 단언하는 대상이 아니다.
      participants: [],
    });

    const body = document.querySelector('.people-body');
    expect(body).not.toBeNull();

    // 참여자 행은 없다 — global은 참여자 "목록"을 갖지 않으므로 이 자체는 맞다.
    expect(body?.querySelectorAll('.person').length ?? -1).toBe(0);

    // 그러나 빈 칸이어서는 안 된다 — DESIGN.md :70이 지정한 muted 스타일
    // (.pending-note 재사용)로 "이유"를 담은 노드가 있어야 한다. 정확한
    // 문구는 DESIGN 관할이라 하드코딩하지 않는다 — 존재와 "비어있지 않음"만
    // 확인한다.
    const reason = body?.querySelector('.pending-note');
    expect(reason).not.toBeNull();
    expect((reason?.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('GA-34 단언2 (회귀 축): user room이 활성일 때는 종전대로 참여자 목록이 나온다', () => {
    renderParticipantList({
      nickname: 'user1',
      hasRoom: true,
      isGlobal: false,
      participants: ['user1', 'user2'],
    });

    const body = document.querySelector('.people-body');
    const rows = body?.querySelectorAll('.person') ?? [];
    expect(rows.length).toBe(2);
    screen.getByText('user2'); // 존재하지 않으면 스스로 throw — 존재 증명.

    // 본인은 "나" 배지로 구분된다 (기존 동작, ParticipantList.tsx:29) — 이
    // 축이 isGlobal 도입으로 깨지지 않는지 함께 확인한다.
    const selfRow = Array.from(rows).find((r) => r.textContent?.includes('user1'));
    expect(selfRow?.querySelector('.me-badge')).not.toBeNull();
  });
});
