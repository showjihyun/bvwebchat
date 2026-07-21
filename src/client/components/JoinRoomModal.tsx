import { useState, type FormEvent } from 'react';

interface Props {
  existingRooms: string[];
  availableRooms: string[];
  onJoin: (room: string) => void;
  onCancel: () => void;
}

const RESERVED = 'global'; // ADR-0004: 예약 이름 (특수 room은 RQ-04에서 구현)

/**
 * room 참여 모달 (DESIGN.md §5 room 생성 모달 스타일 차용).
 * "생성"과 "참여"는 서버상 동일(join)하다 — 이름으로 room에 들어간다.
 * RQ-13: 서버가 방송한 존재 room 목록(availableRooms)에서 아직 참여하지 않은
 * room을 골라 참여할 수 있다. global(예약, 자동 참여)·이미 참여한 room은 목록에서
 * 제외한다. 새 이름 입력으로 새 room 생성도 계속 가능하다. 이름 고유성은
 * 서버(RQ-13)가 강제하며, 여기서는 클라이언트 레벨 방어를 함께 둔다.
 */
export function JoinRoomModal({ existingRooms, availableRooms, onJoin, onCancel }: Props) {
  const [value, setValue] = useState('');
  const name = value.trim();

  // 참여 가능한 기존 room 디렉토리: global(예약)·이미 참여 중인 room 제외.
  const joinable = availableRooms.filter(
    (room) => room.toLowerCase() !== RESERVED && !existingRooms.includes(room),
  );

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
        {joinable.length > 0 && (
          <div className="room-directory">
            <div className="section-label">참여할 수 있는 room</div>
            {joinable.map((room) => (
              <button
                key={room}
                type="button"
                className="room-item"
                onClick={() => onJoin(room)}
              >
                <span className="hash">#</span>
                <span className="name">{room}</span>
              </button>
            ))}
          </div>
        )}
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
