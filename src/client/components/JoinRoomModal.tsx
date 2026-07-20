import { useState, type FormEvent } from 'react';

interface Props {
  existingRooms: string[];
  onJoin: (room: string) => void;
  onCancel: () => void;
}

const RESERVED = 'global'; // ADR-0004: 예약 이름 (특수 room은 RQ-04에서 구현)

/**
 * room 참여 모달 (DESIGN.md §5 room 생성 모달 스타일 차용).
 * RQ-01 슬라이스에서는 "생성"과 "참여"가 서버상 동일(join)하다 — 이름으로 room에
 * 들어간다. 이름 고유성 강제(RQ-13)·global 특수 처리(RQ-04)는 서버 미구현이라
 * 클라이언트 레벨의 최소 방어만 둔다.
 */
export function JoinRoomModal({ existingRooms, onJoin, onCancel }: Props) {
  const [value, setValue] = useState('');
  const name = value.trim();

  let error: string | null = null;
  if (name.toLowerCase() === RESERVED) {
    error = "'global'은 예약된 이름입니다";
  } else if (existingRooms.includes(name)) {
    error = '이미 참여 중인 room입니다';
  }
  const canJoin = name.length > 0 && error === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canJoin) onJoin(name);
  };

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">room 참여</div>
        <div className="field">
          <input
            className={`input${name && error ? ' error' : ''}`}
            placeholder="room 이름"
            value={value}
            autoFocus
            aria-label="room 이름"
            onChange={(e) => setValue(e.target.value)}
          />
          {name && error && <div className="caption error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onCancel}>
            취소
          </button>
          <button className="btn-primary" type="submit" disabled={!canJoin}>
            참여
          </button>
        </div>
      </form>
    </div>
  );
}
