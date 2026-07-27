#!/usr/bin/env python3
"""세션 시작 다이제스트 — SessionStart hook.

상태 계약(T.04)의 자동 이행부. **≤15줄이 계약의 일부다** — 길면 안 읽히고,
안 읽히는 계약은 없는 계약이다. 그래서 줄 수를 하드 상한으로 강제한다.

내용은 "git이 모르는 것"에 집중한다. 무엇을 고쳤는지는 git log가 안다.
git이 모르는 건 **왜**, **다음 무엇**, **열린 질문** 셋이다.

서브프로세스를 띄우지 않는다 — 세션 시작이 느리면 사람이 훅을 끈다.
"""
import sys
from pathlib import Path

MAX_LINES = 15
WHY_WIDTH = 150


def clip(text: object, width: int = 110) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= width else s[: width - 1] + "…"


def newest_mtime(root: Path, subdirs) -> tuple[float, str]:
    import os
    newest, where = 0.0, ""
    for sub in subdirs:
        base = root / sub
        if not base.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in {"__pycache__", "node_modules", ".git"}]
            for fn in filenames:
                try:
                    m = (Path(dirpath) / fn).stat().st_mtime
                except OSError:
                    continue
                if m > newest:
                    newest, where = m, (Path(dirpath) / fn).relative_to(root).as_posix()
    return newest, where


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "harness"))
    try:
        import _state as st
    except ImportError:
        sys.exit(0)  # 하네스 미설치 — 조용히 빠진다

    matrix, _risk, pstatus = st.load_policy(root)
    if pstatus != "ok":
        sys.exit(0)

    state, sstatus = st.read_phase_state(root)
    session = st.read_session(root)
    branch, sha = st.head_info(root)
    phase = state.get("phase", st.DEFAULT_PHASE)
    pd = st.phase_def(matrix, phase)
    rq = ((session.get("task") or {}).get("rq")) or state.get("rq") or "UNSET"
    mode = "warn_only" if st.is_warn_only(matrix, phase) else "block"

    lines = [f"[하네스] RQ {rq} · 단계 {phase}({mode}) · {branch or '?'}@{(sha or '')[:8]}"
             + (f" · 상태 {sstatus} → IDLE 강등" if sstatus in ("corrupt", "tampered") else "")]
    lines.append(f"[왜] {clip(session.get('goal'), WHY_WIDTH) or '(미선언 — checkpoint-resume 스킬로 세션을 선언하라)'}")

    # 마지막 검증: 전이 로그가 곧 증거다 (사람의 기억이 아니라)
    log = st.read_jsonl(st.state_dir(root) / st.PHASE_LOG, limit=50)
    if log:
        last = log[-1]
        gs = last.get("guards") or []
        verdict = "없음" if not gs else ("전원 PASS" if all(g.get("ok") for g in gs)
                                            else "실패 " + ",".join(g["name"] for g in gs if not g.get("ok")))
        lines.append(f"[마지막 검증] {last.get('ts', '')} {last.get('from')}→{last.get('to')}"
                     f" · 가드 {verdict}" + (" · FORCED" if last.get("forced") else ""))
    else:
        lines.append("[마지막 검증] 전이 기록 없음 — 이 브랜치에서 아직 단계를 밟지 않았다")

    done = session.get("done") or []
    if done:
        lines.append(f"[한 것] {len(done)}건 · " + clip(" / ".join(map(str, done[-2:]))))
    for i, nxt in enumerate((session.get("next") or [])[:3], 1):
        lines.append(f"[다음 {i}] {clip(nxt)}")
    q = session.get("open_questions") or []
    if q:
        lines.append(f"[열린 질문] {len(q)}건 · " + clip(q[0], 95))

    lines.append(f"[쓰기 허용] {' '.join(pd.get('write_allow', [])) or '(없음)'}")
    lines.append(f"[다음 전이] {clip(pd.get('exit_hint', ''), 130)}")

    # 문서 낡음 — 서브프로세스 없이 mtime 으로만 보는 자문(advisory) 신호.
    # 정밀 판정은 CI 의 doc-freshness.mjs --pr 이 한다.
    chlog = root / "docs/harness/changelog.md"
    if chlog.exists():
        newest, where = newest_mtime(root, (".claude/hooks", "harness", "scripts"))
        if newest > chlog.stat().st_mtime:
            lines.append(f"[문서 낡음] {where} 가 changelog.md 보다 새롭다 — 하네스 변경 기록 의무(CLAUDE.md)")

    if len(lines) > MAX_LINES:
        lines = lines[: MAX_LINES - 1] + [f"[…] {len(lines) - MAX_LINES + 1}줄 생략 — python harness/phase.py resume"]
    print("\n".join(lines))
    sys.exit(0)


if __name__ == "__main__":
    main()
