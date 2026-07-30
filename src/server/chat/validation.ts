// 이름과 문자열에 대한 규칙. 순수 함수만 있고 부수 효과가 없다.
//
// **[PURE]** — socket.io를 타입으로도 import 하지 않는다(ADR-0007 규칙3,
// eslint no-restricted-imports로 기계 강제). 여기 있는 함수들은 실제 소켓
// 핸드셰이크 없이 그대로 단위 테스트할 수 있다 — 특히
// generateUniqueNickname의 접미사 탐색(GA-11)은 통합 테스트로는 identify
// 왕복을 거쳐야만 닿는 로직이었다.
//
// 계층(ADR-0007 규칙2): L1 — shared/types에만 의존한다.

import { GLOBAL_ROOM } from '../../shared/types';

/** join/leave의 room·nickname 검증 — 빈 문자열만 거른다(공백은 통과). */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * identify 전용 검증 — 공백만으로 이뤄진 nickname도 "닉네임 미입력"으로
 * 취급한다 (rq-10-nickname-identity.test.ts 파일 상단 계약 주석 "비어있는
 * 문자열(또는 공백만)"). join/leave의 isNonEmptyString은 그대로 둔다(무변경).
 */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * ADR-0004 결정3 / RQ-13 GA-24: room **생성(join)** 요청에서 'global'을
 * 예약 이름으로 거부하기 위한 검사 — 대소문자를 무시한다.
 *
 * ⚠️ 이름에 `ForCreation`이 붙은 것은 스타일이 아니라 **경계 표시**다.
 * leave 경로의 global 검사는 대소문자를 무시하지 않고 `=== GLOBAL_ROOM`
 * 정확 일치이며(room.ts의 handleLeave), 이 비대칭은 의도적으로 보존된다
 * (ADR-0007 결과 절). 오늘 `leave({room:'GLOBAL'})`은 ok:true를 돌려주고
 * socket.leave('GLOBAL')과 유령 room에 대한 participants 방송까지 수행한다 —
 * 어떤 통합 테스트도 이 경로를 덮지 않으므로, 이 함수를 leave 쪽에
 * 재사용하면 **테스트가 전부 초록인 채로 행동이 바뀐다.** join에서만 쓴다.
 *
 * room 이름을 trim 하지 않는 것도 의도다 — `' global '`은 오늘 합법적인
 * room 이름이며(RQ-13 minor-2, 명시적으로 이월됨) 여기서 정규화를 추가하면
 * 스코프 밖 행동 변경이 된다.
 */
export function isReservedRoomNameForCreation(room: string): boolean {
  return room.toLowerCase() === GLOBAL_ROOM;
}

/**
 * base가 미점유면 그대로, 점유 중이면 "base-2", "base-3", ... 형태로 최초로
 * 비어 있는 접미사를 찾아 반환한다 (RQ-10 GA-11). 형식은 스펙이 강제하지
 * 않으므로(원문 "예: alice-2") 이 구분자·시작값을 이 세션의 설계 결정으로
 * 확정한다.
 */
export function generateUniqueNickname(base: string, nicknamesInUse: ReadonlySet<string>): string {
  if (!nicknamesInUse.has(base)) {
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (nicknamesInUse.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
