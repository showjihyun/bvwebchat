// RQ-05 / ADR-0006: 프로덕션 정적 클라이언트 서빙.
// 빌드된 dist/client를 서빙하고, 알 수 없는 경로는 index.html로 폴백한다(SPA).
// /health는 배포 스모크용 헬스체크. 외부 의존성 없이 node:http/fs만 사용한다.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { RequestListener } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

/**
 * dist/client 루트를 서빙하는 request 핸들러를 만든다.
 * - `/health` → 200 "ok" (스모크 헬스체크).
 * - 존재하는 정적 파일 → 해당 파일 + MIME.
 * - 그 외(자산 아님) → index.html 폴백 (SPA 라우팅).
 * 경로 순회(`..`)는 정규화 후 루트 밖이면 거부한다.
 */
export function createStaticHandler(clientDir: string): RequestListener {
  const indexPath = join(clientDir, 'index.html');
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // 요청 경로를 clientDir 하위로 정규화 — 루트 밖 접근 차단.
    const rel = normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(clientDir, rel);
    if (!filePath.startsWith(clientDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    // 디렉토리이거나 미존재 파일 → SPA 폴백(index.html).
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = indexPath;
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    createReadStream(filePath).pipe(res);
  };
}
