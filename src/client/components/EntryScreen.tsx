import { useState, type FormEvent } from 'react';

interface Props {
  onEnter: (nickname: string) => void;
}

const MIN_NICKNAME = 2;

/** 입장 화면 (DESIGN.md §5) — 닉네임 하나로 입장. 최소 2자 미만이면 버튼 비활성. */
export function EntryScreen({ onEnter }: Props) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const tooShort = trimmed.length < MIN_NICKNAME;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tooShort) onEnter(trimmed);
  };

  return (
    <div className="entry-screen">
      <form className="entry-form" onSubmit={submit}>
        <div className="entry-title">닉네임으로 입장</div>
        <div className="field">
          <input
            className="input"
            placeholder="닉네임 (2자 이상)"
            value={value}
            autoFocus
            aria-label="닉네임"
            onChange={(e) => setValue(e.target.value)}
          />
          {tooShort && (
            <div className="caption">
              {trimmed.length === 0 ? '닉네임을 입력하세요' : '닉네임은 2자 이상 입력하세요'}
            </div>
          )}
        </div>
        <button className="btn-primary" type="submit" disabled={tooShort}>
          입장
        </button>
      </form>
    </div>
  );
}
