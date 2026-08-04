import { GLOBAL_ROOM } from '../../shared/types';

interface Props {
  rooms: string[];
  activeRoom: string | null;
  unreadByRoom: Record<string, number>;
  onSelect: (room: string) => void;
  onNewRoom: () => void;
}

/**
 * room 목록 (DESIGN.md §5). 참여한 room을 표시하고, 안 읽음은 이름 굵기 +
 * 우측 숫자 배지로 나타낸다 (RQ-18, DESIGN §5 개정 — 점 대신 숫자, 상한 50).
 * 전체 room 디렉토리(RQ-13)는 참여 모달에, global 조회 탭은 RQ-04 몫.
 *
 * RQ-18-a / GA-31: `rooms`(= useChat의 참여 user room 목록, GA-28의 given이
 * 고정한 의미 그대로 — global을 담지 않는다)와 별개로, global은 이 컴포넌트가
 * 렌더 시점에 최상단에 합성하는 상시 슬롯이다(ADR-0004 자동 참여·나가기 불가와
 * 대칭 — DESIGN.md:64/:84 "global 상단 고정, 삭제 UI 없음"). `useChat.rooms`의
 * 내부 의미는 바뀌지 않으므로 GA-28과 모순되지 않는다.
 */
export function RoomList({ rooms, activeRoom, unreadByRoom, onSelect, onNewRoom }: Props) {
  const displayRooms = [GLOBAL_ROOM, ...rooms];
  return (
    <div className="col-rooms">
      <div className="col-header brand">웹챗</div>
      <div className="rooms-body">
        <div className="section-label">채널</div>
        {rooms.length === 0 && (
          <div className="pending-note">아직 참여한 room이 없습니다. 아래에서 room에 참여하세요.</div>
        )}
        {displayRooms.map((room) => {
          const unread = unreadByRoom[room] ?? 0;
          const hasUnread = unread > 0 && room !== activeRoom;
          return (
            <button
              key={room}
              className={`room-item${room === activeRoom ? ' selected' : ''}${hasUnread ? ' unread' : ''}`}
              onClick={() => onSelect(room)}
            >
              <span className="hash">#</span>
              <span className="name">{room}</span>
              {hasUnread && <span className="unread-badge">{unread}</span>}
            </button>
          );
        })}
      </div>
      <div className="rooms-footer">
        <button className="btn-outline" onClick={onNewRoom}>
          + room 참여
        </button>
      </div>
    </div>
  );
}
