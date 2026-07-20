import { avatarColor, avatarInitial } from '../avatar';

interface Props {
  nickname: string;
  size?: 'lg' | 'sm';
}

/** 이니셜 아바타 (DESIGN.md §5) — 첫 글자 + 닉네임 해시 색상. */
export function Avatar({ nickname, size = 'lg' }: Props) {
  return (
    <div className={`avatar ${size}`} style={{ background: avatarColor(nickname) }} aria-hidden="true">
      {avatarInitial(nickname)}
    </div>
  );
}
