#!/usr/bin/env python3
"""단계×경로 쓰기 게이트 — PreToolUse (Write|Edit|MultiEdit|NotebookEdit|Bash).

**이 훅은 정확히 한 가지 일만 한다** (anti-02): R1(로컬 변경)의 단계 의존
판정. R0/R2/R3은 settings.json permissions 가 전담한다 — 단계와 무관한 정적
정책이기 때문이다. 이 분담이 깨지면 훅이 권한 시스템의 열등한 복제가 된다.

**예산 ≤150ms. 서브프로세스를 절대 띄우지 않는다.** 가드 실행(node/git)은
전부 `phase.py enter` 쪽에 있다. 느린 게이트는 꺼지는 게이트이고, 꺼진
게이트는 없는 게이트다.

실패 방향이 두 가지로 갈린다 — 의도적이다:
  - 정책 파일 부재  → **fail-OPEN**. 하네스 미설치 저장소에서 이 훅이
    모든 쓰기를 막으면 그냥 고장난 도구다.
  - 상태 파일 손상·서명 불일치 → **fail-CLOSED**(IDLE). 하네스는 설치돼
    있는데 상태를 못 믿는다면, 못 믿는 상태로 판정하느니 가장 좁은 단계로
    떨어뜨린다.
"""
import json
import re
import sys
import time
from pathlib import Path

# 판정 순서 (00_approved-plan.md §2)
#   1. stdin 디코드   2. 루트 해석   3. 정책 로드   4. 도구 분류
#   5. 상태 로드      6. 경로 판정   7. warn_only 반영   8. 기록

FILE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def emit(decision: str, reason: str) -> None:
    """deny/ask 는 stdout JSON 으로. allow 는 아무것도 출력하지 않는다.

    ensure_ascii=True 는 취향이 아니라 방어다. Windows 한국어 로케일에서
    stdout 이 파이프로 잡히면 인코딩이 cp949 가 되고, 한글·em dash 를 그대로
    쓰면 UnicodeEncodeError 로 훅이 exit 1 하며 죽는다 — 죽은 게이트는
    fail-open 이다. 실제로 이 함수의 첫 판 실증에서 그렇게 죽었다.
    reconfigure 와 이중으로 막는다: 어느 한쪽이 실패해도 판정은 나간다.
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }, ensure_ascii=True))
    sys.stdout.flush()
    sys.exit(0)


def warn(text: str) -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    sys.stderr.write(text + "\n")


def log_block(root: Path, record: dict) -> None:
    """S1 센서 원료 + M8(게이트 차단)의 유일한 직접 증거. 실패·차단만 적는다."""
    try:
        p = root / ".harness/logs/tools.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        pass  # 로깅 실패가 판정을 바꾸면 안 된다


# ------------------------------------------------------------- 메시지 조립

def phase_offering(matrix: dict, rel: str, current: str) -> str:
    """이 경로를 지금 쓸 수 있는 단계를 매트릭스에서 역으로 찾는다.
    '어디로 가면 되는지'를 알려주지 않는 차단은 벽이지 문이 아니다."""
    import _state as st
    for name, pd in (matrix.get("phases") or {}).items():
        if name == current:
            continue
        if st.first_match(rel, pd.get("write_deny", [])):
            continue
        if st.first_match(rel, pd.get("write_allow", [])):
            guards = []
            for row in matrix.get("transitions") or []:
                if row.get("from") == current and name in (row.get("to") or []):
                    guards = row.get("guards") or []
                    break
            g = f" (가드: {', '.join(guards)})" if guards else " (가드 없음)"
            reachable = any(
                row.get("from") in (current, "*") and name in (row.get("to") or [])
                for row in matrix.get("transitions") or []
            )
            if reachable:
                return f"이 경로는 {name} 단계의 쓰기 허용이다 → python harness/phase.py enter {name}{g}"
            return (f"이 경로는 {name} 단계의 쓰기 허용이지만 {current}에서 바로 갈 수 없다 "
                    f"→ python harness/phase.py show 로 경로를 확인하라")
    return ("이 경로는 **어느 단계에서도** 쓰기 허용이 아니다. 통제면 파일이거나 "
            "스크립트가 쓰는 파일이다 — 손으로 고칠 대상이 아니다")


def deny_message(matrix: dict, phase: str, rel: str, tool: str,
                 deny_pat: str | None) -> str:
    pd = (matrix.get("phases") or {}).get(phase) or {}
    basis = (f"write_deny 패턴 '{deny_pat}' 에 매칭됐다"
             if deny_pat else
             f"{phase} 의 write_allow 어디에도 매칭되지 않았다 (default-deny)")
    allow = " ".join(pd.get("write_allow", [])) or "(없음)"
    return (
        f"[phase-gate] {phase} 단계에서 {tool}({rel}) 를 차단했다.\n"
        f"\n"
        f"왜: {pd.get('purpose', '')}\n"
        f"    판정 근거 — {basis} (harness/policy/phase-matrix.json)\n"
        f"\n"
        f"고치는 법 3가지:\n"
        f"  1) {phase_offering(matrix, rel, phase)}\n"
        f"  2) 지금 이 단계에서 쓸 수 있는 곳: {allow}\n"
        f"     {pd.get('exit_hint', '')}\n"
        f"  3) 정말 지금 이 파일이어야 한다면 사유를 남기고 강제한다 →\n"
        f"     python harness/phase.py force <PHASE> --reason \"...\"\n"
        f"     (사람 승인 필요 · phase.jsonl 에 forced:true 로 박제 · 주간 리포트 최상단 노출)\n"
        f"\n"
        f"이건 요청이 아니라 구조적 차단이다. 설득할 상대가 없다 — 경로 매트릭스가\n"
        f"판정했고, 단계를 바꾸는 것만이 판정을 바꾼다. 재시도는 M8(게이트 차단)에 쌓인다."
    )


def redirect_message(target: str, prefix: str, cmd: str) -> str:
    return (
        f"[phase-gate] Bash 리다이렉트로 통제면 경로에 쓰려는 시도를 차단했다.\n"
        f"\n"
        f"대상: {target}   (보호 접두사 '{prefix}', harness/policy/tool-risk.json)\n"
        f"명령: {cmd[:200]}\n"
        f"왜: 이 경로들은 게이트·가드·골든 정답이 사는 곳이다. 셸 리다이렉트로 여기를\n"
        f"    고치면 통제면이 자기 자신을 판정하지 못하게 된다.\n"
        f"\n"
        f"고치는 법 3가지:\n"
        f"  1) 상태 파일이라면 → python harness/phase.py enter|force 를 쓴다.\n"
        f"     .harness/state/ 의 유일한 writer 는 phase.py 다 (서명이 붙는다).\n"
        f"  2) 골든/정책 파일이라면 → 사람 승인이 필요하다. Write 도구로 편집을\n"
        f"     제안하면 permissions.ask 가 사람에게 묻는다.\n"
        f"  3) 로그를 보려던 것이라면 → 리다이렉트 없이 그냥 출력하라.\n"
        f"\n"
        f"이건 예방이 아니라 탐지다(설계상 명시). node -e 로 우회하면 이 훅은 못 막지만,\n"
        f"CI 의 phase-audit 이 git 이력에서 순서를 독립 재유도해 사후 대조한다."
    )


# ------------------------------------------------------------------- 판정

_REDIRECT_RE = re.compile(r'(?<![0-9&])>>?\s*(?:"([^"]+)"|\'([^\']+)\'|([^\s;|&<>()]+))')


def bash_targets(cmd: str):
    for m in _REDIRECT_RE.finditer(cmd):
        t = m.group(1) or m.group(2) or m.group(3) or ""
        t = t.strip()
        if not t or t.startswith("&"):  # 2>&1 같은 fd 복제는 파일이 아니다
            continue
        t = t.replace("\\", "/")
        # lstrip("./") 을 쓰면 안 된다 — 문자 집합으로 동작해서
        # '.harness/state/x' 의 선행 '.' 까지 먹고 보호 접두사 매칭이 조용히
        # 빗나간다. 첫 실증에서 리다이렉트 차단이 통과된 원인이 이것이었다.
        yield t[2:] if t.startswith("./") else t


def main() -> None:
    t0 = time.monotonic()

    # 1. stdin 을 **바이트로 읽어 UTF-8 로 명시 디코딩**한다. Windows 한국어
    #    로케일에서 기본 인코딩(cp949)에 의존하면 한글 포함 페이로드가 디코딩
    #    실패로 게이트를 통째로 우회(fail-open)한다. 실제로 겪은 실패다.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    tool = payload.get("tool_name") or ""
    if tool not in FILE_TOOLS and tool != "Bash":
        sys.exit(0)

    # 2. 루트는 페이로드의 cwd 에서 위로 올라가 찾는다 — 하드코딩 금지.
    #    서브 에이전트·워크트리에서 cwd 가 달라도 같은 판정이 나와야 한다.
    start = Path(payload.get("cwd") or ".")
    root = None
    try:
        for cand in (start.resolve(), *start.resolve().parents):
            if (cand / "CLAUDE.md").exists() or ((cand / ".git").exists() and (cand / "harness").is_dir()):
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
        sys.exit(0)  # 하네스 미설치 → fail-OPEN

    # 3. 정책: 부재 = fail-OPEN, 손상 = 시끄러운 실패(exit 2)
    matrix, risk, pstatus = st.load_policy(root)
    if pstatus == "missing":
        sys.exit(0)
    if pstatus != "ok":
        warn("[phase-gate] harness/policy/*.json 을 파싱할 수 없다. 통제면이 고장난 상태에서는\n"
             "판정하지 않는다 — 정책 파일을 고치거나 훅을 떼라. "
             "(node scripts/policy-lint.mjs 로 진단)")
        sys.exit(2)

    # 4. 상태: 부재·손상·서명 불일치 → IDLE (fail-CLOSED)
    state, sstatus = st.read_phase_state(root)
    phase = state.get("phase", st.DEFAULT_PHASE)
    warn_only = st.is_warn_only(matrix, phase)

    # 5. Bash: 이 훅의 관할은 보호 경로 리다이렉트 탐지 하나뿐이다.
    #    접두사 분류(R0/R2/R3)는 settings.json 의 일이다.
    if tool == "Bash":
        cmd = (payload.get("tool_input") or {}).get("command") or ""
        prefixes = ((risk or {}).get("protected_paths") or {}).get("deny_redirect") or []
        for target in bash_targets(cmd):
            for pref in prefixes:
                if target.startswith(pref.replace("\\", "/")):
                    log_block(root, {
                        "ts": st.iso_now(), "kind": "gate_block", "tool": "Bash",
                        "phase": phase, "target": target, "pattern": pref,
                        "session_id": payload.get("session_id"),
                        "ms": int((time.monotonic() - t0) * 1000),
                    })
                    emit("deny", redirect_message(target, pref, cmd))
        sys.exit(0)

    # 6. 파일 쓰기 도구 → 단계×경로 매트릭스
    ti = payload.get("tool_input") or {}
    raw = ti.get("file_path") or ti.get("notebook_path") or ""
    rel = st.rel_path(root, raw)
    if rel is None:
        sys.exit(0)  # 저장소 밖은 이 게이트의 관할이 아니다

    pd = st.phase_def(matrix, phase)
    deny_pat = st.first_match(rel, pd.get("write_deny", []))
    allow_pat = None if deny_pat else st.first_match(rel, pd.get("write_allow", []))
    if allow_pat:
        sys.exit(0)  # allow 는 조용히 통과 — 성공은 로그에 남기지 않는다

    reason = deny_message(matrix, phase, rel, tool, deny_pat)
    log_block(root, {
        "ts": st.iso_now(), "kind": "gate_block", "tool": tool, "phase": phase,
        "path": rel, "pattern": deny_pat, "basis": "write_deny" if deny_pat else "default_deny",
        "state_status": sstatus, "warn_only": warn_only,
        "session_id": payload.get("session_id"),
        "ms": int((time.monotonic() - t0) * 1000),
    })

    if warn_only:
        # 게이트의 첫 주가 가장 위험하다: 차단이 잦으면 force 가 습관이 되고
        # 그 순간 전체가 장식이 된다. 유예 단계는 경고만 하고 통과시킨다.
        warn(reason + "\n\n[warn_only] 이 단계는 아직 유예 중이라 통과시켰다. "
                      "enforce.warn_only 에서 빠지면 이 쓰기는 차단된다.")
        sys.exit(0)

    emit("deny", reason)


if __name__ == "__main__":
    main()
