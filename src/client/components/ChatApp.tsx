import { useState } from 'react';
import { useChat } from '../useChat';
import { RoomList } from './RoomList';
import { ChatPane } from './ChatPane';
import { ParticipantList } from './ParticipantList';
import { JoinRoomModal } from './JoinRoomModal';

interface Props {
  // RQ-10-a: null이면 "닉네임 미확정, 유효한 세션 토큰으로 resume해서 확정해야 한다"
  // (App이 이 경우에만 null을 넘긴다). 화면 표시(ChatPane/ParticipantList)는 이 prop이
  // 아니라 chat.nickname(useChat이 resume/identify ack로 확정한 값)을 쓴다.
  nickname: string | null;
  // resume이 실패했을 때(유예 만료·무효 토큰) App이 진입 화면으로 되돌아가도록 알린다.
  // nickname이 non-null일 때(이미 진입 화면을 통과한 일반 세션)는 호출되지 않는다.
  onResumeFail?: () => void;
}

/** 메인 3단 레이아웃 (DESIGN.md §4). RQ-01 슬라이스: 실 서버 join/message 연결. */
export function ChatApp({ nickname, onResumeFail }: Props) {
  const chat = useChat(nickname, onResumeFail);
  const [modalOpen, setModalOpen] = useState(false);

  const activeMessages = chat.activeRoom ? (chat.messagesByRoom[chat.activeRoom] ?? []) : [];
  const activeParticipants = chat.activeRoom ? (chat.participantsByRoom[chat.activeRoom] ?? []) : [];

  return (
    <div className="app-shell">
      <RoomList
        rooms={chat.rooms}
        activeRoom={chat.activeRoom}
        unreadByRoom={chat.unreadByRoom}
        onSelect={chat.setActiveRoom}
        onNewRoom={() => setModalOpen(true)}
      />
      <ChatPane
        room={chat.activeRoom}
        nickname={chat.nickname}
        messages={activeMessages}
        status={chat.status}
        onSend={chat.sendMessage}
        onNewRoom={() => setModalOpen(true)}
      />
      <ParticipantList
        nickname={chat.nickname}
        hasRoom={chat.activeRoom !== null}
        participants={activeParticipants}
      />
      {modalOpen && (
        <JoinRoomModal
          existingRooms={chat.rooms}
          availableRooms={chat.availableRooms}
          onCancel={() => setModalOpen(false)}
          onJoin={(room) => {
            chat.joinRoom(room);
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
