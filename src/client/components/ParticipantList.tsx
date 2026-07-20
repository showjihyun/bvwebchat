import { Avatar } from './Avatar';

interface Props {
  nickname: string;
  hasRoom: boolean;
}

/**
 * 참여자 패널 (DESIGN.md §5, 상시 노출). RQ-01 슬라이스: 서버가 참여자 목록을
 * 제공하지 않으므로(RQ-15 미구현) 본인만 표시하고 나머지는 RQ-15에서 채운다.
 * — 없는 데이터를 지어내지 않는다.
 */
export function ParticipantList({ nickname, hasRoom }: Props) {
  return (
    <div className="col-people">
      <div className="col-header overline">참여자</div>
      <div className="people-body">
        {hasRoom ? (
          <>
            <div className="person">
              <Avatar nickname={nickname} size="sm" />
              <span>{nickname}</span>
              <span className="me-badge">나</span>
            </div>
            <div className="pending-note">
              다른 참여자 목록은 RQ-15(참여자 목록 표시) 구현 시 표시됩니다.
            </div>
          </>
        ) : (
          <div className="pending-note">room에 참여하면 표시됩니다.</div>
        )}
      </div>
    </div>
  );
}
