import { Avatar } from './Avatar';
import { displayNickname } from '../avatar';

interface Props {
  nickname: string;
  hasRoom: boolean;
  isGlobal: boolean;
  participants: string[];
}

/**
 * 참여자 패널 (DESIGN.md §5, 상시 노출). RQ-15: 서버 `participants` 방송으로
 * 받은 현재 room 참여자를 표시한다. 본인은 "나" 배지로 구분한다.
 * 참여자 순서는 서버가 정한 join 순서를 그대로 따른다.
 *
 * ADR-0008: global 은 참여자 목록을 갖지 않는다(서버가 `state.members`에
 * global을 등록하지 않음 — ADR-0004 예외 2 "전원 종료 후 global 존속"의
 * 집행 수단이라 서버를 고치지 않는다). `isGlobal`이 true면 빈 칸 대신
 * 이유를 `.pending-note`(DESIGN.md :70 재사용 지정)로 조용히 표시한다.
 */
export function ParticipantList({ nickname, hasRoom, isGlobal, participants }: Props) {
  const showList = hasRoom && !isGlobal;
  return (
    <div className="col-people">
      <div className="col-header overline">
        참여자{showList && participants.length > 0 ? ` (${participants.length})` : ''}
      </div>
      <div className="people-body">
        {showList ? (
          participants.map((name) => (
            <div className="person" key={name}>
              <Avatar nickname={name} size="sm" />
              <span className="person-name" title={name}>
                {displayNickname(name)}
              </span>
              {name === nickname && <span className="me-badge">나</span>}
            </div>
          ))
        ) : hasRoom && isGlobal ? (
          <div className="pending-note">
            global은 모든 사용자가 자동으로 접속되어 있어 참여자를 따로 집계하지 않습니다.
          </div>
        ) : (
          <div className="pending-note">room에 참여하면 표시됩니다.</div>
        )}
      </div>
    </div>
  );
}
