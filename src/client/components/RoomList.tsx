interface Props {
  rooms: string[];
  activeRoom: string | null;
  onSelect: (room: string) => void;
  onNewRoom: () => void;
}

/**
 * room 목록 (DESIGN.md §5). RQ-01 슬라이스: 참여한 room만 표시한다.
 * global 특수 room(RQ-04/ADR-0004)·안 읽음(RQ-18)·전체 목록(RQ-13)은
 * 해당 서버 기능 구현 시 붙인다.
 */
export function RoomList({ rooms, activeRoom, onSelect, onNewRoom }: Props) {
  return (
    <div className="col-rooms">
      <div className="col-header brand">웹챗</div>
      <div className="rooms-body">
        <div className="section-label">채널</div>
        {rooms.length === 0 && (
          <div className="pending-note">아직 참여한 room이 없습니다. 아래에서 room에 참여하세요.</div>
        )}
        {rooms.map((room) => (
          <button
            key={room}
            className={`room-item${room === activeRoom ? ' selected' : ''}`}
            onClick={() => onSelect(room)}
          >
            <span className="hash">#</span>
            <span className="name">{room}</span>
          </button>
        ))}
      </div>
      <div className="rooms-footer">
        <button className="btn-outline" onClick={onNewRoom}>
          + room 참여
        </button>
      </div>
    </div>
  );
}
