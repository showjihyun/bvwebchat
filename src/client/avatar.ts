// 이니셜 아바타 (DESIGN.md §5) — 닉네임 해시로 8색 중 하나를 결정한다.
// 흰 이니셜 대비 전부 ≥4.5:1 (DESIGN.md §2에서 검증된 8색).
const AVATAR_COLORS = [
  '#3B5BDB',
  '#0B7285',
  '#2B8A3E',
  '#9C36B5',
  '#C2255C',
  '#E8590C',
  '#6741D9',
  '#495057',
] as const;

/** 닉네임 → 결정론적 색상. 같은 닉네임은 항상 같은 색. */
export function avatarColor(nickname: string): string {
  let hash = 0;
  for (let i = 0; i < nickname.length; i += 1) {
    hash = (hash * 31 + nickname.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

/** 닉네임 첫 글자 (한글 포함, 코드포인트 1개). 빈 문자열이면 '?'. */
export function avatarInitial(nickname: string): string {
  const first = [...nickname][0];
  return first ?? '?';
}

/**
 * 채팅 표시용 닉네임 — 전체를 보여주되 10자를 넘으면 10자 + '…'로 축약한다.
 * (코드포인트 기준으로 잘라 한글·이모지가 중간에서 깨지지 않게 한다.)
 * 원본은 title 속성으로 노출해 hover 시 전체를 확인할 수 있게 한다.
 */
export function displayNickname(nickname: string): string {
  const chars = [...nickname];
  return chars.length > 10 ? chars.slice(0, 10).join('') + '…' : nickname;
}
