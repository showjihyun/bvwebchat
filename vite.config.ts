import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 클라이언트 빌드/개발 서버. 테스트 설정은 vitest.config.ts에 분리.
// FE는 :5173(Vite dev), Socket.IO 서버는 :3001. same-origin으로 붙여 CORS를
// 피하기 위해 /socket.io를 서버로 프록시한다 (ws:true) — RQ-01 서버 코드 무변경.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: '../../dist/client', emptyOutDir: true },
});
