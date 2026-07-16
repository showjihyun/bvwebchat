#!/usr/bin/env python3
"""스펙 동결 게이트 — PreToolUse hook (Write|Edit|MultiEdit).

Deep Interview가 끝나기 전(specs/requirements.md에 🟡 PENDING이 남아 있는 동안)
구현 산출물(src/, tests/ 등)의 생성·수정을 차단한다.

원칙(CLAUDE.md): "반드시"는 hook으로 강제한다. 스펙이 모호한 상태의 구현은
전부 추측이고, 추측 구현은 인터뷰 후 재작업이 된다.
exit 2 = 도구 호출 차단. stderr 메시지는 에이전트가 읽고 자기 교정한다.
이 hook은 메인 세션뿐 아니라 서브 에이전트(coder·test-writer)에도 적용된다.
"""
import json
import sys
from pathlib import Path

BLOCKED_TOP_DIRS = {"src", "tests", "test", "__tests__"}
SPEC = Path("specs/requirements.md")


def main() -> None:
    # stdin을 바이트로 읽어 UTF-8로 명시 디코딩한다. Windows 한국어 로케일에서
    # 기본 인코딩(cp949)에 의존하면 한글 포함 페이로드가 디코딩 실패로
    # 게이트를 우회(fail-open)하게 된다.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        sys.exit(0)

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    if not file_path:
        sys.exit(0)

    try:
        rel = Path(file_path).resolve().relative_to(Path.cwd().resolve())
    except (ValueError, OSError):
        sys.exit(0)  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다

    if not rel.parts or rel.parts[0] not in BLOCKED_TOP_DIRS:
        sys.exit(0)

    if not SPEC.exists():
        sys.exit(0)  # 스펙 파일 부재는 다른 문제 — 이 게이트가 판단하지 않는다

    # RQ 항목 줄만 센다 — 문서 상단 범례의 🟡까지 세면 건수가 부풀려진다
    pending = sum(
        1
        for line in SPEC.read_text(encoding="utf-8").splitlines()
        if line.lstrip().startswith("- **RQ") and "🟡" in line
    )
    if pending > 0:
        # stderr를 UTF-8로 고정 — cp949 콘솔 기본값으로 나가면
        # 에이전트가 읽는 교정 메시지의 한글이 깨진다
        sys.stderr.reconfigure(encoding="utf-8")
        print(
            f"[스펙 동결 게이트] Deep Interview 미완료 — requirements.md에 "
            f"PENDING(🟡) {pending}건이 남아 있어 '{rel}' 수정을 차단한다. "
            f"specs/interview/question-bank.md로 인터뷰를 먼저 완료해 모든 🟡를 "
            f"확정(✅)하라. 스펙이 모호한 구현은 추측이며, 추측은 재작업이 된다.",
            file=sys.stderr,
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
