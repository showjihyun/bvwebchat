#!/usr/bin/env python3
"""상태 갱신 강제 — Stop hook.

이 세션이 저장소를 바꿔 놓고(R1 쓰기 ≥1) session.json 을 갱신하지 않은 채
끝나려 하면 **한 번** 막는다. 이유: 상태 계약(T.04)이 깨지는 지점은 거의
항상 여기다 — 일은 했는데 "왜 했는지"가 아무 데도 안 남는다. git 은 무엇을
했는지 알지만 이유는 모른다.

**반드시 stop_hook_active 를 확인하고 true면 즉시 빠진다.** 확인하지 않으면
차단 → 재개 → 차단의 무한 루프가 된다. 이 필드가 이 훅의 유일한 안전장치다.

한 번만 막는 두 번째 이유: 두 번째 차단은 정보를 0 추가하면서 사람의 신뢰만
깎는다. 마커 파일로 세션당 1회를 보장한다.
"""
import json
import subprocess
import sys
from pathlib import Path

R1_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def warn(text: str) -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    sys.stderr.write(text + "\n")


def counted_r1_writes(transcript: str) -> int:
    n = 0
    try:
        with open(transcript, encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"tool_use"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" \
                            and block.get("name") in R1_TOOLS:
                        n += 1
    except OSError:
        return 0
    return n


def newest_commit_iso(root: Path) -> str:
    try:
        p = subprocess.run(["git", "log", "-1", "--format=%cI"], cwd=str(root),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return (p.stdout or "").strip() if p.returncode == 0 else ""


def to_epoch(iso: str) -> float:
    import datetime
    if not iso:
        return 0.0
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def main() -> None:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    # 무한 루프 방지 — 이 검사 없이는 훅이 자기 자신을 영원히 재호출한다.
    if payload.get("stop_hook_active"):
        sys.exit(0)

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "harness"))
    try:
        import _state as st
    except ImportError:
        sys.exit(0)

    session_file = st.state_dir(root) / st.SESSION_FILE
    if not session_file.exists():
        sys.exit(0)  # 세션 선언 자체가 없으면 이 훅의 관할이 아니다

    transcript = payload.get("transcript_path")
    writes = counted_r1_writes(transcript) if transcript else 0
    if writes < 1:
        sys.exit(0)  # 아무것도 안 바꿨으면 갱신할 상태도 없다

    sid = str(payload.get("session_id") or "unknown")
    marker = root / ".harness/logs" / f"stop-blocked-{st.branch_slug(sid)}.marker"
    if marker.exists():
        sys.exit(0)  # 세션당 1회

    session = st.read_session(root)
    updated = to_epoch(session.get("updated") or "")
    head_iso = newest_commit_iso(root)
    head_at = to_epoch(head_iso)
    if head_at == 0.0 or updated >= head_at:
        sys.exit(0)

    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(st.iso_now(), encoding="utf-8")
    except OSError:
        pass

    state, _ = st.read_phase_state(root)
    warn(
        f"[stop-state] 이 세션은 R1 쓰기를 {writes}회 했는데 .harness/state/session.json 이\n"
        f"최신 커밋보다 낡았다 (session.updated={session.get('updated') or '없음'} < HEAD={head_iso}).\n"
        f"\n"
        f"git 은 네가 **무엇을** 했는지 이미 안다. git 이 모르는 건 **왜**다. 그걸 남기지 않고\n"
        f"세션을 끝내면 다음 세션(또는 다른 사람)은 diff 를 역공학해야 한다 — 그게 T.04\n"
        f"상태 계약이 막으려는 실패다.\n"
        f"\n"
        f"끝내기 전에 session.json 을 갱신하라 (단계 {state.get('phase', 'IDLE')}):\n"
        f"  1) goal — 왜 이 작업을 하는지 (무엇이 아니라)\n"
        f"  2) done — 이번 세션에 끝난 것\n"
        f"  3) next — 다음 세션이 집어들 3개 · open_questions — 미해결 판단\n"
        f"  그리고 updated 를 지금 시각(ISO)으로.\n"
        f"\n"
        f"이 차단은 세션당 한 번뿐이다. 정말 지금 끝내야 하면 그냥 다시 끝내면 된다."
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
