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
  /** 서버가 고유화(자동 접미사)한 닉네임 (RQ-10, ADR-0003) */
  nickname: string;
  body: string;
}
