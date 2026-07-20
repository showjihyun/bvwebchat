import { Avatar } from './Avatar';

interface Props {
  nickname: string;
  hasRoom: boolean;
  participants: string[];
}

/**
 * 참여자 패널 (DESIGN.md §5, 상시 노출). RQ-15: 서버 `participants` 방송으로
 * 받은 현재 room 참여자를 표시한다. 본인은 "나" 배지로 구분한다.
 * 참여자 순서는 서버가 정한 join 순서를 그대로 따른다.
 */
export function ParticipantList({ nickname, hasRoom, participants }: Props) {
  return (
    <div className="col-people">
      <div className="col-header overline">
        참여자{hasRoom && participants.length > 0 ? ` (${participants.length})` : ''}
      </div>
      <div className="people-body">
        {hasRoom ? (
          participants.map((name) => (
            <div className="person" key={name}>
              <Avatar nickname={name} size="sm" />
              <span>{name}</span>
              {name === nickname && <span className="me-badge">나</span>}
            </div>
          ))
        ) : (
          <div className="pending-note">room에 참여하면 표시됩니다.</div>
        )}
      </div>
    </div>
  );
}
