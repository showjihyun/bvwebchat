#!/usr/bin/env python3
"""도구 실행 관측 + 빠른 검증 — PostToolUse hook.

두 가지 일을 한다. 합친 이유는 하나의 이벤트(도구 실행 직후)에 대한 하나의
반응이기 때문이다 — 훅을 둘로 쪼개면 매 Write마다 파이썬 프로세스가 둘 뜬다.

1. **S1 센서**: 도구 실행 *실패*만 .harness/logs/tools.jsonl 에 적는다.
   성공은 적지 않는다 — S1이 답하는 질문은 "행위가 먹혔나"이고, 성공 로그는
   그 질문에 아무 답도 하지 않으면서 파일만 키운다. "같은 파일 6번 수정",
   "Edit 3연속 실패"는 실패 기록만으로 보인다.
2. **빠른 검증**: 코드 파일을 건드렸을 때만 `node scripts/check.mjs --fast`.
   .md·.json 을 고칠 때 eslint+tsc 를 띄우는 건 순수 낭비이고, 낭비하는
   훅은 결국 꺼진다.
"""
import json
import subprocess
import sys
from pathlib import Path

FILE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
CHECK_TIMEOUT_S = 120


def warn(text: str) -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    sys.stderr.write(text + "\n")


def tool_failed(response: object) -> tuple[bool, str]:
    """PostToolUse 의 tool_response 는 도구마다 모양이 다르다. 관대하게 본다."""
    if isinstance(response, dict):
        if response.get("success") is False:
            return True, str(response.get("error") or response.get("stderr") or "success=false")
        if response.get("is_error"):
            return True, str(response.get("error") or response.get("content") or "is_error")
        if response.get("error"):
            return True, str(response["error"])
        code = response.get("exit_code") if "exit_code" in response else response.get("returncode")
        if isinstance(code, int) and code != 0:
            return True, f"exit_code={code}: {str(response.get('stderr') or '')[:300]}"
    elif isinstance(response, str) and response.lstrip().lower().startswith("error"):
        return True, response[:300]
    return False, ""


def main() -> None:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    root_hint = Path(payload.get("cwd") or Path(__file__).resolve().parents[2])
    root = None
    try:
        for cand in (root_hint.resolve(), *root_hint.resolve().parents):
            if (cand / "CLAUDE.md").exists():
                root = cand
                break
    except OSError:
        pass
    if root is None:
        sys.exit(0)

    sys.path.insert(0, str(root / "harness"))
    try:
        import _state as st
    except ImportError:
        sys.exit(0)

    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}
    failed, detail = tool_failed(payload.get("tool_response"))

    # --- 1. S1: 실패만 기록 ---
    if failed:
        state, _ = st.read_phase_state(root)
        rec = {
            "ts": st.iso_now(), "kind": "tool_failure", "tool": tool,
            "phase": state.get("phase", st.DEFAULT_PHASE),
            "session_id": payload.get("session_id"),
            "detail": detail[:400],
        }
        path = ti.get("file_path") or ti.get("notebook_path")
        if path:
            rec["path"] = st.rel_path(root, path) or path
        if tool == "Bash":
            rec["command"] = str(ti.get("command") or "")[:200]
        try:
            st.append_jsonl(root / ".harness/logs/tools.jsonl", rec)
        except OSError:
            pass

    # --- 2. 빠른 검증: 코드 파일을 성공적으로 쓴 경우만 ---
    if failed or tool not in FILE_TOOLS:
        sys.exit(0)
    raw = ti.get("file_path") or ti.get("notebook_path") or ""
    if Path(raw).suffix.lower() not in CODE_SUFFIXES:
        sys.exit(0)
    check = root / "scripts/check.mjs"
    if not check.exists():
        sys.exit(0)  # W1 산출물이 아직 없다 — 조용히 빠진다

    # 도구 사슬 부재는 '네 변경이 깨뜨렸다'가 아니다. 여기서 exit 2 로 막으면
    # 매 쓰기마다 틀린 진단이 나가고, 정작 처방(npm ci)은 세션 안에서 실행할
    # 수 없다(R2 = 사람 승인). 막지 말고 **정확히** 말하고 빠진다.
    missing = st.toolchain_missing(root)
    if missing:
        warn(f"[post-observe] 빠른 검증을 건너뛴다 — {missing}. 방금 쓴 파일 문제가 아니라\n"
             f"  환경 문제다. 복구: npm ci (tool-risk.json 상 R2 — 사람 승인이 필요하다).\n"
             f"  복구 전까지 lint/typecheck/test 는 아무것도 검증하지 않는다는 점을 유의하라.")
        sys.exit(0)

    try:
        p = subprocess.run(
            ["node", "scripts/check.mjs", "--fast"], cwd=str(root),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=CHECK_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        warn(f"[post-observe] check.mjs --fast 실행 실패: {e} — 검증을 건너뛴다")
        sys.exit(0)

    if p.returncode != 0:
        tail = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-25:]
        warn("[post-observe] node scripts/check.mjs --fast 실패 — 방금 쓴 파일이 원인일 가능성이 높다.\n"
             + "\n".join(tail)
             + "\n고쳐라. 테스트·린트를 약화시켜 우회하지 않는다(CLAUDE.md).")
        sys.exit(2)  # exit 2 = stderr 가 에이전트에게 전달돼 자기 교정에 쓰인다
    sys.exit(0)


if __name__ == "__main__":
    main()
