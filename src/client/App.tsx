import { useState } from 'react';
import { EntryScreen } from './components/EntryScreen';
import { ChatApp } from './components/ChatApp';

/** 입장 전에는 닉네임 폼, 입장 후에는 채팅 앱 (RQ-01 슬라이스). */
export function App() {
  const [nickname, setNickname] = useState<string | null>(null);

  if (nickname === null) {
    return <EntryScreen onEnter={setNickname} />;
  }
  return <ChatApp nickname={nickname} />;
}
