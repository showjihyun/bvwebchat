# 배포 절차 (RQ-05 / ADR-0006)

사내망 단일 서버(RQ-17)에 Docker 단일 컨테이너로 배포한다. 클라이언트와
Socket.IO가 한 포트로 노출되는 단일 서버다.

## 성공 기준

배포는 "프로세스가 떴다"가 아니라 **골든 스모크(GA-01 격리 · GA-04 global)가
프로덕션 인스턴스에서 통과**하면 성공이다. 스모크 실패 = 배포 실패.

## CI가 하는 일 (자동)

`.github/workflows/deploy.yml`은 main 머지 시:
1. Docker 이미지를 빌드하고,
2. 컨테이너를 기동해 헬스체크 후,
3. `scripts/smoke.sh`로 GA-01·GA-04를 실제 소켓으로 재실행한다.

즉 CI는 **배포 아티팩트가 골든을 통과함**을 보장한다. GitHub 러너는 사내망에
도달할 수 없으므로 실제 반입은 아래 수동 절차다.

## 사내 서버 반입 (수동)

사내 서버(Docker 설치됨)에서:

```bash
# 1) 소스 반입 후 이미지 빌드 (또는 사내 레지스트리에서 pull)
git clone <저장소> && cd bvwebchat
docker build -t bvwebchat:latest .

# 2) 기동 — PORT는 원하는 포트로 매핑 (기본 3001)
docker run -d --name bvwebchat --restart unless-stopped -p 80:3001 bvwebchat:latest

# 3) 배포 검증 — 골든 스모크를 실제 배포 URL에 대해 실행
#    (socket.io-client 필요 → npm ci 후)
npm ci
bash scripts/smoke.sh http://<사내서버>:80
```

스모크가 통과하면 배포 완료. 실패하면 `docker logs bvwebchat`로 원인 확인.

## 운영 메모

- **인메모리 상태**(ADR-0002/0003): 컨테이너 재시작 시 메시지·세션·닉네임이
  전부 소실된다(사내 데모의 수용된 정책). 무중단이 필요하면 재설계 대상.
- **HTTPS**: 컨테이너는 평문 HTTP 단일 포트. 필요 시 사내 리버스 프록시
  (nginx 등)에서 TLS 종단.
- **동시 100명**(RQ-16): 단일 프로세스 이벤트 루프로 충분(ADR-0001 전제).
- **업데이트**: 새 이미지 빌드 → `docker rm -f bvwebchat` → 다시 `docker run`.
