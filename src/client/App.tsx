import { useState } from 'react';
import { EntryScreen } from './components/EntryScreen';
import { ChatApp } from './components/ChatApp';
import { TOKEN_KEY } from './useChat';

/**
 * 입장 전에는 닉네임 폼, 입장 후에는 채팅 앱 (RQ-01 슬라이스).
 *
 * RQ-10-a: 새로고침해도 유효한 세션 토큰이 있으면 닉네임을 다시 묻지 않는다.
 * 마운트 시점에 토큰 존재만으로(내용 검증 없이) `resuming`을 결정해 진입 화면을
 * 건너뛰고 ChatApp을 먼저 띄운다 — 실제 유효성 판정(resume ack)은 서버만 할 수
 * 있으므로 ChatApp(useChat)이 그 결과를 `onResumeFail`로 알려준다. 토큰이 없거나
 * resume이 거부되면(유예 만료·무효 토큰) 진입 화면으로 돌아간다 — 그렇지 않으면
 * 폴백 경로를 잃고 사실상 영구 로그인이 된다.
 */
export function App() {
  const [nickname, setNickname] = useState<string | null>(null);
  const [resuming, setResuming] = useState(() => localStorage.getItem(TOKEN_KEY) !== null);

  if (resuming) {
    return <ChatApp nickname={null} onResumeFail={() => setResuming(false)} />;
  }
  if (nickname === null) {
    return <EntryScreen onEnter={setNickname} />;
  }
  return <ChatApp nickname={nickname} />;
}
