// 공유 메시지 타입 — 서버·클라이언트가 같은 shape을 사용한다 (ADR-0001).
// 경계면 버그(서버 전송 shape ≠ 클라이언트 파싱 shape)를 타입으로 차단하는 시드.

/** room 이름이 곧 고유 식별자다 (RQ-13). */
export type RoomName = string;

/** 예약된 상설 room — 대소문자 무시 비교로 생성 거부 (ADR-0004, RQ-13 예외). */
export const GLOBAL_ROOM: RoomName = 'global';

/**
 * 서버가 room 참여자 전원에게 브로드캐스트하는 메시지 (RQ-02, RQ-04).
 * 추가 필드(순서 번호·타임스탬프 등)는 테스트/ADR이 요구할 때 확장한다 —
 * 스캐폴드에 미확정 설계를 시드하지 않는다 (PR #9 리뷰 m-1).
 */
export interface ChatMessage {
  room: RoomName;
  /** 서버가 join 시 이 소켓에 연결한 발신 닉네임. identify(RQ-10)로 고유화된
   *  값을 쓰는 것은 클라이언트 관례이며, 서버 발급 토큰으로 강제하는 것은
   *  ADR-0003 세션 토큰 후속(RQ-10 잔여)에서 닫는다. */
  nickname: string;
  body: string;
  /** RQ-04-a / ADR-0009 결정4: global에서 이 room으로 팬아웃된 사본임을
   *  나타내는 표시. room 원본(즉 room === GLOBAL_ROOM인 메시지)에는 붙이지
   *  않는다 — 붙이면 클라이언트가 "origin이 있으면 칩" 규칙을 못 쓴다
   *  (_workspace/RQ-04-a/plan.md §2-4). GA-41이 이 필드의 존재(이름은
   *  고정하지 않지만 이 구현은 plan.md 제안을 그대로 따른다)를 판정한다. */
  origin?: 'global';
}
