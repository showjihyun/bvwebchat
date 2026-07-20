import { useState } from 'react';
import { useChat } from '../useChat';
import { RoomList } from './RoomList';
import { ChatPane } from './ChatPane';
import { ParticipantList } from './ParticipantList';
import { JoinRoomModal } from './JoinRoomModal';

interface Props {
  nickname: string;
}

/** 메인 3단 레이아웃 (DESIGN.md §4). RQ-01 슬라이스: 실 서버 join/message 연결. */
export function ChatApp({ nickname }: Props) {
  const chat = useChat(nickname);
  const [modalOpen, setModalOpen] = useState(false);

  const activeMessages = chat.activeRoom ? (chat.messagesByRoom[chat.activeRoom] ?? []) : [];
  const activeParticipants = chat.activeRoom ? (chat.participantsByRoom[chat.activeRoom] ?? []) : [];

  return (
    <div className="app-shell">
      <RoomList
        rooms={chat.rooms}
        activeRoom={chat.activeRoom}
        onSelect={chat.setActiveRoom}
        onNewRoom={() => setModalOpen(true)}
      />
      <ChatPane
        room={chat.activeRoom}
        nickname={nickname}
        messages={activeMessages}
        status={chat.status}
        onSend={chat.sendMessage}
        onNewRoom={() => setModalOpen(true)}
      />
      <ParticipantList
        nickname={nickname}
        hasRoom={chat.activeRoom !== null}
        participants={activeParticipants}
      />
      {modalOpen && (
        <JoinRoomModal
          existingRooms={chat.rooms}
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
