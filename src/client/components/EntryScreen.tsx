import { useState, type FormEvent } from 'react';

interface Props {
  onEnter: (nickname: string) => void;
}

/** 입장 화면 (DESIGN.md §5) — 닉네임 하나로 입장. 미입력 시 버튼 비활성. */
export function EntryScreen({ onEnter }: Props) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const empty = trimmed.length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!empty) onEnter(trimmed);
  };

  return (
    <div className="entry-screen">
      <form className="entry-form" onSubmit={submit}>
        <div className="entry-title">닉네임으로 입장</div>
        <div className="field">
          <input
            className="input"
            placeholder="닉네임"
            value={value}
            autoFocus
            aria-label="닉네임"
            onChange={(e) => setValue(e.target.value)}
          />
          {empty && <div className="caption">닉네임을 입력하세요</div>}
        </div>
        <button className="btn-primary" type="submit" disabled={empty}>
          입장
        </button>
      </form>
    </div>
  );
}
