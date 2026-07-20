import { useState, type FormEvent } from 'react';

interface Props {
  room: string;
  disabled: boolean;
  onSend: (body: string) => void;
}

/** 입력창 (DESIGN.md §5). 재연결 중에는 전송 불가 상태. */
export function Composer({ room, disabled, onSend }: Props) {
  const [value, setValue] = useState('');
  const canSend = !disabled && value.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(value);
    setValue('');
  };

  return (
    <form className="composer" onSubmit={submit}>
      <input
        className="input"
        placeholder={disabled ? '재연결 중에는 보낼 수 없습니다' : `#${room}에 메시지 보내기`}
        value={value}
        disabled={disabled}
        aria-label="메시지 입력"
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="btn-primary" type="submit" disabled={!canSend}>
        전송
      </button>
    </form>
  );
}
