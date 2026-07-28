#!/usr/bin/env python3
"""단계 상태 머신 — .harness/state/phase.json 의 **유일한** writer.

    python harness/phase.py show
    python harness/phase.py why
    python harness/phase.py enter GREEN
    python harness/phase.py force GREEN --reason "..."
    python harness/phase.py resume

핵심 설계(00_approved-plan.md §2):

> 합법적 간선도 **직전 단계만 만들 수 있는 산출물**을 요구한다.
> 단계를 뒤집는 건 막을 수 없지만, 뒤집어도 얻는 게 없게 만들었다.

가드 실행이 여기 있고 게이트(hooks/gate_phase.py)에는 없는 이유: 게이트는 매
Write마다 뜨므로 서브프로세스 예산이 없다(≤150ms). 전이는 하루 몇 번이므로
전체 테스트를 돌려도 된다. **느린 게이트는 꺼지는 게이트다.**
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _state as st  # noqa: E402

GUARD_TIMEOUT_S = 900  # 전체 검증(vitest 포함)이 들어간다
SESSION_MAX_LINES = 60  # session.json 분량 계약 (자문 — 초과해도 쓰기는 한다)


def _out(*args: object) -> None:
    print(*args)


# ------------------------------------------------------------------ git 헬퍼

def git(root: Path, *args: str) -> tuple[int, str]:
    try:
        p = subprocess.run(
            ["git", *args], cwd=str(root), capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, f"git 실행 실패: {e}"
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def merge_base(root: Path, ref: str = "main") -> str | None:
    for candidate in (ref, f"origin/{ref}"):
        code, out = git(root, "merge-base", candidate, "HEAD")
        if code == 0 and out.strip():
            return out.strip().splitlines()[0]
    return None


def pathspec(glob: str) -> str:
    """쓰기 매트릭스 glob → git pathspec. 'tests/**' → 'tests'"""
    return re.sub(r"/\*\*$", "", glob).rstrip("/") or "."


# -------------------------------------------------------------------- 가드

class GuardResult:
    __slots__ = ("name", "ok", "hint", "detail", "ms")

    def __init__(self, name: str, ok: bool, hint: str = "", detail: str = "", ms: int = 0):
        self.name, self.ok, self.hint, self.detail, self.ms = name, ok, hint, detail, ms

    def as_log(self) -> dict:
        rec = {"name": self.name, "ok": self.ok, "ms": self.ms}
        if not self.ok and self.detail:
            rec["detail"] = self.detail[:500]
        return rec


def _iter_files(root: Path, glob: str):
    """glob에 매칭되는 실재 파일. 노이즈 디렉터리는 통째로 건너뛴다."""
    skip = {".git", "node_modules", "dist", "coverage", ".harness", "__pycache__"}
    for dirpath, dirnames, filenames in __import__("os").walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        base = Path(dirpath)
        for fn in filenames:
            rel = (base / fn).relative_to(root).as_posix()
            if st.path_matches(rel, glob):
                yield base / fn


# 짝 없는 서로게이트를 가리키는 패턴 탐지.
# JSON 에 "\\ud83d" 처럼 역슬래시를 이중으로 쓰면 json.loads 는 리터럴
# "\ud83d" 를 내놓고, re 는 그것을 U+D83D(고아 서로게이트) 로 해석한다.
# 파이썬 문자열에서 🟡 는 단일 코드포인트 U+1F7E1 이므로 **어떤 입력에도 매칭되지
# 않는다** — 가드는 조용히 "0건"을 돌려주며 영원히 통과한다.
# 2026-07-27 실제로 no_pending_spec 이 이 상태였다. gate_spec_freeze.py 를 영구
# no-op 이라는 이유로 지우고 그 기능을 흡수한 가드가, 다른 이유로 똑같이 no-op 였다.
_LONE_SURROGATE_ESC = re.compile(r"\\u[dD][89a-fA-F][0-9a-fA-F]{2}")


def guard_grep_count(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    pattern = spec["pattern"]
    bad = _LONE_SURROGATE_ESC.findall(pattern) + [
        f"U+{ord(c):04X}" for c in pattern if 0xD800 <= ord(c) <= 0xDFFF]
    if bad:
        # 통과가 아니라 실패로 처리한다: 판정할 수 없는 가드는 없는 가드다.
        return False, (
            f"패턴이 짝 없는 서로게이트({', '.join(map(str, bad))})를 가리킨다 — "
            f"어떤 문자열에도 매칭되지 않으므로 이 가드는 영구 통과 상태다. "
            f"phase-matrix.json 의 pattern 에서 역슬래시 이중 이스케이프를 풀고 "
            f"문자를 그대로 쓰라(예: 🟡)."), {}
    target = root / spec["file"]
    if not target.exists():
        return False, f"파일이 없다: {spec['file']}", {}
    rx = re.compile(pattern)
    text = target.read_text(encoding="utf-8", errors="replace")
    n = sum(1 for line in text.splitlines() if rx.search(line))
    expect = spec.get("expect", 0)
    return n == expect, f"{spec['file']}: 매칭 {n}건 (기대 {expect}건)", {"n": n}


def guard_state_field(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    data, status = st.read_json(root / spec["file"])
    if status != "ok" or data is None:
        return False, f"{spec['file']} 를 읽을 수 없다 ({status})", {}
    missing = []
    for dotted in spec.get("require", []):
        cur: object = data
        for part in dotted.split("."):
            if not isinstance(cur, dict) or part not in cur:
                cur = None
                break
            cur = cur[part]
        if cur is None or (isinstance(cur, (str, list, dict)) and len(cur) == 0):
            missing.append(dotted)
    if missing:
        return False, f"비어 있는 필드: {', '.join(missing)}", {}
    return True, "필수 필드 전부 존재", {}


_RE_NO_CHANGES = re.compile(r"no_staged_or_unstaged_changes_in\((.*)\)")
_RE_COMMIT_COUNT = re.compile(
    r"count\(commits\(HEAD\s*\^merge-base\((\w[\w/-]*)\)\)\s*touching\s*(\S+?)\)\s*(>=|>|==)\s*(\d+)")
_RE_CHANGED_IN_BRANCH = re.compile(r"changed_in_branch\((.+?)\)")


def guard_git(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    expr = spec.get("expr", "")

    m = _RE_NO_CHANGES.fullmatch(expr.strip())
    if m:
        globs = [g.strip() for g in m.group(1).split(",") if g.strip()]
        code, out = git(root, "status", "--porcelain")
        if code != 0:
            return False, f"git status 실패: {out.strip()[:200]}", {}
        dirty = []
        for line in out.splitlines():
            if len(line) < 4:
                continue
            path = line[3:].split(" -> ")[-1].strip().strip('"')
            if any(st.path_matches(path, g) for g in globs):
                dirty.append(path)
        if dirty:
            return False, "커밋되지 않은 변경: " + ", ".join(dirty[:8]), {"n": len(dirty)}
        return True, f"{', '.join(globs)} 워킹트리 clean", {}

    m = _RE_COMMIT_COUNT.fullmatch(expr.strip())
    if m:
        base_ref, glob, op, want = m.group(1), m.group(2), m.group(3), int(m.group(4))
        base = merge_base(root, base_ref)
        if base is None:
            return False, f"merge-base({base_ref}) 를 구하지 못했다", {}
        code, out = git(root, "rev-list", "--count", "HEAD", f"^{base}", "--", pathspec(glob))
        if code != 0:
            return False, f"git rev-list 실패: {out.strip()[:200]}", {}
        try:
            n = int(out.strip().splitlines()[0])
        except (ValueError, IndexError):
            return False, f"커밋 수를 파싱하지 못했다: {out.strip()[:120]}", {}
        ok = {">=": n >= want, ">": n > want, "==": n == want}[op]
        return ok, f"{glob} 를 건드린 브랜치 커밋 {n}건 (기대 {op} {want})", {"n": n}

    m = _RE_CHANGED_IN_BRANCH.fullmatch(expr.strip())
    if m:
        target = m.group(1).strip()
        base = merge_base(root)
        touched = []
        if base:
            code, out = git(root, "diff", "--name-only", f"{base}..HEAD", "--", target)
            if code == 0:
                touched += [ln for ln in out.splitlines() if ln.strip()]
        code, out = git(root, "status", "--porcelain", "--", target)
        if code == 0:
            touched += [ln[3:] for ln in out.splitlines() if ln.strip()]
        if touched:
            return True, f"{target} 가 이 브랜치에서 변경됨", {"n": len(touched)}
        return False, f"{target} 가 이 브랜치에서 변경되지 않았다", {"n": 0}

    # 평가할 수 없는 표현식은 통과시키지 않는다 — 못 읽는 가드는 없는 가드다
    return False, f"알 수 없는 git 표현식: {expr!r} (phase.py가 지원하지 않는다)", {}


def guard_exec(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    cmd = [st.interpolate(str(a), var) for a in spec.get("cmd", [])]
    if not cmd:
        return False, "cmd 가 비어 있다", {}
    # 스크립트 부재를 트레이스백이 아니라 문장으로 알린다 (W1 병행 작업 중)
    for arg in cmd[1:]:
        if arg.endswith((".mjs", ".js", ".cjs", ".py")) and not (root / arg).exists():
            return False, (
                f"이 스크립트가 아직 없다: {arg} — 가드 {'/'.join(cmd[:2])} 를 평가할 수 없다. "
                f"스크립트를 만든 뒤 다시 전이하라."
            ), {}
    started = time.monotonic()
    try:
        p = subprocess.run(
            cmd, cwd=str(root), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=GUARD_TIMEOUT_S,
        )
    except FileNotFoundError:
        return False, f"이 스크립트가 아직 없다 / 실행 파일을 찾을 수 없다: {cmd[0]}", {}
    except subprocess.TimeoutExpired:
        return False, f"{' '.join(cmd)} 가 {GUARD_TIMEOUT_S}초를 넘겨 중단됐다", {}
    elapsed = int((time.monotonic() - started) * 1000)
    want = spec.get("expect_exit", 0)
    tail = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-15:]
    detail = f"exit={p.returncode} (기대 {want}), {elapsed}ms\n" + "\n".join(tail)
    if p.returncode != want:
        # 실패했을 때만 '왜'를 나눈다. 먼저 막지 않는 이유: 센서 스크립트는
        # Node stdlib 만 쓰므로 node_modules 없이도 돈다. 미리 차단하면
        # 평가 가능한 가드를 거짓 실패시킨다 — 게이트를 실제보다 넓게 잡는 것은
        # 게이트를 부정확하게 만드는 것이고, 부정확한 게이트는 안 믿긴다.
        missing = st.toolchain_missing(root)
        if missing:
            # 단정하지 않는다. 스크립트마다 node_modules 필요 여부가 다르고
            # (센서 6종은 stdlib 만 쓴다), 원인을 잘못 지목하는 게이트는
            # 원인을 안 알려주는 게이트보다 나쁘다 — 사람을 틀린 곳으로 보낸다.
            detail = (f"[참고] {missing}. 이 실패가 그 때문일 수 있다 — 복구는 "
                      f"npm ci (R2, 사람 승인). 아래 실제 출력을 먼저 확인하라.\n" + detail)
    return p.returncode == want, detail, {}


def guard_file_contains(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    rel = st.interpolate(spec["file"], var)
    target = root / rel
    if not target.exists():
        return False, f"파일이 없다: {rel}", {}
    text = target.read_text(encoding="utf-8", errors="replace")
    if not re.search(spec["pattern"], text):
        return False, f"{rel} 에 패턴 {spec['pattern']!r} 가 없다", {}
    newer = spec.get("newer_than_glob")
    if newer:
        report_mtime = target.stat().st_mtime
        newest, newest_path = 0.0, ""
        for f in _iter_files(root, newer):
            try:
                m = f.stat().st_mtime
            except OSError:
                continue
            if m > newest:
                newest, newest_path = m, f.relative_to(root).as_posix()
        if newest > report_mtime:
            return False, (
                f"{rel} 작성 이후 {newest_path} 가 변경됐다 "
                f"(보고서 {time.strftime('%H:%M:%S', time.localtime(report_mtime))} "
                f"< 소스 {time.strftime('%H:%M:%S', time.localtime(newest))})"
            ), {}
    return True, f"{rel} 에서 패턴 확인", {}


GUARD_KINDS = {
    "grep_count": guard_grep_count,
    "state_field": guard_state_field,
    "git": guard_git,
    "exec": guard_exec,
    "file_contains": guard_file_contains,
}


def run_guard(root: Path, name: str, matrix: dict, var: dict) -> GuardResult:
    spec = (matrix.get("guards") or {}).get(name)
    started = time.monotonic()
    if spec is None:
        return GuardResult(name, False, f"가드 정의가 없다: {name}", "phase-matrix.json guards 누락", 0)
    fn = GUARD_KINDS.get(spec.get("kind", ""))
    if fn is None:
        return GuardResult(name, False, f"지원하지 않는 가드 kind: {spec.get('kind')!r}", "", 0)
    try:
        ok, detail, extra = fn(root, spec, var)
    except Exception as e:  # 가드 버그로 전이가 통과되면 안 된다 — 실패로 취급
        ok, detail, extra = False, f"가드 실행 중 예외: {type(e).__name__}: {e}", {}
    ms = int((time.monotonic() - started) * 1000)
    hint = st.interpolate(spec.get("fail_hint", ""), {**var, **extra})
    return GuardResult(name, ok, hint, detail, ms)


# ---------------------------------------------------------------- 전이 그래프

def edge_for(matrix: dict, cur: str, target: str) -> dict | None:
    rows = matrix.get("transitions") or []
    for row in rows:
        if row.get("from") == cur and target in (row.get("to") or []):
            return row
    for row in rows:
        if row.get("from") == "*" and target in (row.get("to") or []):
            return row
    return None


def targets_from(matrix: dict, cur: str) -> list[str]:
    out: list[str] = []
    for row in matrix.get("transitions") or []:
        if row.get("from") in (cur, "*"):
            out += [t for t in (row.get("to") or []) if t not in out]
    return out


# ------------------------------------------------------------------- 컨텍스트

def context(root: Path) -> dict:
    state, status = st.read_phase_state(root)
    session = st.read_session(root)
    branch, sha = st.head_info(root)
    rq = (((session.get("task") or {}).get("rq")) or state.get("rq") or "UNSET")
    return {
        "state": state, "status": status, "session": session,
        "branch": branch, "sha": sha, "rq": rq,
        "phase": state.get("phase", st.DEFAULT_PHASE),
        "var": {"rq": rq, "branch_slug": st.branch_slug(branch)},
    }


def record_transition(root: Path, ctx: dict, target: str, guards: list[GuardResult],
                      forced: bool, reason: str | None, edge_legal: bool) -> Path:
    ts = st.iso_now()
    session = ctx["session"]
    # seq — 전이 일련번호. ts 가 동률이어도 순서가 결정되는 타이브레이커다.
    # 소비자(resume-test 등)는 (ts, seq) 로 정렬해야 '최신'이 실제 최신이 된다.
    seq = len(st.read_jsonl(st.state_dir(root) / st.PHASE_LOG)) + 1
    entry = {
        "seq": seq,
        "ts": ts, "from": ctx["phase"], "to": target, "rq": ctx["rq"],
        "branch": ctx["branch"], "head_sha": ctx["sha"],
        "forced": forced, "edge_legal": edge_legal,
        "reason": reason,
        "guards": [g.as_log() for g in guards],
        "actor": "harness/phase.py",
    }
    st.append_jsonl(st.state_dir(root) / st.PHASE_LOG, entry)

    # 불변 체크포인트 — 신선한 클론에서 재개가 가능해야 T.04 계약이 성립한다.
    # 파일명은 콜론 없는 ISO 8601 basic (Windows 파일명 제약).
    ck_dir = st.state_dir(root) / st.CHECKPOINT_DIR / st.branch_slug(ctx["rq"])
    ck_dir.mkdir(parents=True, exist_ok=True)
    stamp, n = st.utc_stamp(), 0
    ck = ck_dir / f"{stamp}.json"
    while ck.exists():
        # 접미사('-1')를 붙이지 않는다 — 정렬이 깨진다. 1ms 씩 밀어
        # 파일명을 순수 숫자로 유지하면 '파일명 정렬 == 시간순'이 지켜진다.
        n += 1
        ck = ck_dir / f"{st.bump_stamp(stamp, n)}.json"
    matrix_phase = st.phase_def(ctx["matrix"], target)
    st.write_json_atomic(ck, {
        "schema": 1, **entry,
        "session": {
            "goal": session.get("goal"),
            "acceptance": session.get("acceptance"),
            "done": session.get("done"),
            "next": session.get("next"),
            "open_questions": session.get("open_questions"),
        },
        "write_allow": matrix_phase.get("write_allow", []),
        "exit_hint": matrix_phase.get("exit_hint", ""),
    })
    return ck


# ------------------------------------------------------------------ 서브커맨드

def cmd_show(root: Path, ctx: dict, args) -> int:
    matrix = ctx["matrix"]
    pd = st.phase_def(matrix, ctx["phase"])
    warn = " [warn_only]" if st.is_warn_only(matrix, ctx["phase"]) else " [block]"
    _out(f"단계   : {ctx['phase']}{warn}")
    _out(f"RQ     : {ctx['rq']}")
    _out(f"브랜치 : {ctx['branch'] or '(unknown)'} @ {(ctx['sha'] or '')[:8]}")
    _out(f"상태   : {ctx['status']}" + (
        "  ← 서명 불일치. IDLE로 취급한다 (fail-closed)" if ctx["status"] == "tampered" else ""))
    _out(f"목적   : {pd.get('purpose', '')}")
    _out(f"쓰기 허용 : {' '.join(pd.get('write_allow', [])) or '(없음)'}")
    _out(f"쓰기 금지 : {' '.join(pd.get('write_deny', [])) or '(명시 없음 — 허용 외 전부 default-deny)'}")
    _out(f"다음    : {' '.join(targets_from(matrix, ctx['phase']))}")
    _out(f"힌트    : {pd.get('exit_hint', '')}")
    for prob in st.hook_wiring_problems(root):
        _out(f"[배선 경고] settings.json → {prob}  ← 이 상태로는 해당 matcher 의 도구가 "
             f"전부 막힌다(python 은 파일 부재에 exit 2 = 차단을 낸다)")
    return 0


def cmd_why(root: Path, ctx: dict, args) -> int:
    s = ctx["session"]
    _out(f"[왜] {s.get('goal') or '(session.json에 goal이 없다 — checkpoint-resume 스킬로 선언하라)'}")
    acc = s.get("acceptance")
    if acc:
        _out(f"[완료 조건] {acc if isinstance(acc, str) else '; '.join(map(str, acc))}")
    log = st.read_jsonl(st.state_dir(root) / st.PHASE_LOG, limit=200)
    _out(f"[전이 이력] 최근 {min(len(log), 8)}건 / 총 {len(log)}건")
    for rec in log[-8:]:
        mark = "FORCED" if rec.get("forced") else "ok"
        failed = [g["name"] for g in rec.get("guards", []) if not g.get("ok")]
        extra = f"  reason={rec.get('reason')}" if rec.get("reason") else ""
        _out(f"  {rec.get('ts')}  {rec.get('from')} → {rec.get('to')}  [{mark}]"
             + (f" 실패가드={failed}" if failed else "") + extra)
    forced_n = sum(1 for r in log if r.get("forced"))
    if log:
        pct = 100.0 * forced_n / len(log)
        flag = "  ← 5% 초과: 에이전트가 아니라 매트릭스가 틀렸다는 신호다" if pct > 5 else ""
        _out(f"[force 비율] {forced_n}/{len(log)} = {pct:.0f}%{flag}")
    q = s.get("open_questions") or []
    if q:
        _out("[열린 질문] " + " / ".join(map(str, q)))
    return 0


def stale_session(root: Path) -> str | None:
    """전이를 막아야 하면 사유 문자열, 아니면 None. **읽기만 한다.**

    왜 여기인가 (recurrence R6, 2회):
    체크포인트는 `session.json` 의 **스냅샷을 품는다**(`record_transition` → `ck.data.session`).
    그리고 `resume-test` 는 커밋된 체크포인트에서 그 스냅샷을 읽는다 — `session.json` 자체는
    gitignore 대상이라 신선한 워크트리에 존재하지 않기 때문이다. 따라서 전이 순간 낡아
    있으면 **낡은 서사가 그대로 박제되고**, 재개 시험은 영영 그것을 읽는다.

    `stop_state.py` 가 같은 검사를 하지만 **세션이 끝날 때**다 — 그때는 체크포인트가 이미
    쓰였고 커밋까지 됐다. 검사는 옳았고 **자리가 틀렸다.** 같은 검사를 박제되는 순간으로
    옮긴다.

    단일 writer 불변식은 그대로다: 이 함수는 `session.json` 을 **읽고 거부**할 뿐 쓰지 않는다.
    쓰기 경로는 여전히 `phase.py session` 하나다.

    **부재 시 통과시킨다 — 그리고 그 사유를 정직하게 적는다** (4차 재리뷰 P-1 정정).

    처음에 "평가 러너가 만드는 워크트리에는 `session.json` 이 없다"고 적었는데
    **거짓이었다** — `eval-b.mjs` 는 워크트리마다 `session.json` 을 시드한다
    (`session_declared` 가드가 `PLAN→RED` 에서 그것을 요구하기 때문이다).
    R1(존재하지 않는 근거를 현재형으로 단언)의 인스턴스이고, R1 을 처방한 그 커밋이
    냈다. C2 는 이것을 잡을 수 없다 — 등재된 **문서**의 낡음을 보지 코드 주석의
    참·거짓을 보지 않는다. 처방의 사각지대다.

    면제의 **진짜** 사유: 아직 상태를 선언한 적 없는 세션을 가두지 않기 위해서다.
    첫 전이(`IDLE→…`)는 `session.json` 이 없는 상태에서 일어나고, 거기서 막으면
    상태 계약을 시작할 방법 자체가 없다. `stop_state.py` 도 같은 이유로 같은 판단을 한다.

    **대가**: 파일을 지우면 이 게이트가 열린다. 예방이 아니라 탐지 쪽이고, 이 설계가
    셸 우회에 대해 이미 선언한 입장과 같다 — 체크포인트에 세션 스냅샷이 비어 있는
    것으로 사후에 드러난다.
    """
    session_file = st.state_dir(root) / st.SESSION_FILE
    if not session_file.exists():
        return None
    session = st.read_session(root)
    updated = session.get("updated") or ""
    head_iso = _newest_commit_iso(root)
    if not head_iso or not updated:
        return None
    if _epoch(updated) >= _epoch(head_iso):
        return None
    return (
        f"session.updated = {updated}\n"
        f"HEAD 커밋      = {head_iso}   ← 이쪽이 나중이다\n"
        f"\n"
        f"체크포인트는 session.json 의 스냅샷을 품고, 재개 시험(GB-06)은 그 스냅샷만 읽는다\n"
        f"— session.json 자체는 gitignore 라 워크트리에 없다. 지금 전이하면 낡은 서사가\n"
        f"그대로 박제되고 다음 세션은 diff 를 역공학해야 한다.\n"
        f"\n"
        f"git 은 네가 무엇을 했는지 이미 안다. git 이 모르는 건 왜다."
    )


def _newest_commit_iso(root: Path) -> str:
    try:
        r = subprocess.run(["git", "log", "-1", "--format=%cI"], cwd=root,
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _epoch(iso: str) -> float:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def cmd_enter(root: Path, ctx: dict, args) -> int:
    matrix, cur, target = ctx["matrix"], ctx["phase"], args.phase.upper()
    if target not in (matrix.get("phases") or {}):
        _out(f"[거부] 알 수 없는 단계: {target}")
        _out("가능한 단계: " + " ".join(matrix["phases"].keys()))
        return 1
    edge = edge_for(matrix, cur, target)
    if edge is None:
        _out(f"[거부] {cur} → {target} 는 전이 테이블에 없는 간선이다.")
        _out(f"  {cur} 에서 갈 수 있는 곳: {' '.join(targets_from(matrix, cur)) or '(없음)'}")
        _out(f"  {st.phase_def(matrix, cur).get('exit_hint', '')}")
        _out(f"  정말 필요하면: python harness/phase.py force {target} --reason \"...\"")
        return 1

    names = edge.get("guards") or []
    results = [run_guard(root, n, matrix, ctx["var"]) for n in names]
    if names:
        _out(f"[가드] {cur} → {target}: {len(names)}건 평가")
        for g in results:
            _out(f"  {'PASS' if g.ok else 'FAIL'}  {g.name}  ({g.ms}ms)  {g.detail.splitlines()[0] if g.detail else ''}")

    failed = [g for g in results if not g.ok]
    if failed:
        _out("")
        _out(f"[거부] {cur} → {target} — 가드 {len(failed)}건 실패. 단계는 그대로 {cur} 다.")
        for g in failed:
            _out("")
            _out(f"  ✗ {g.name}")
            for line in g.hint.splitlines():
                _out(f"    {line}")
            if g.detail:
                _out(f"    ── 실제 관측: {g.detail.splitlines()[0]}")
                for line in g.detail.splitlines()[1:]:
                    _out(f"       {line}")
        _out("")
        _out("이 가드들은 '직전 단계만 만들 수 있는 산출물'을 요구한다. 우회하면 다음 단계에서")
        _out("얻을 게 없어진다. 정말 필요하면 사유를 남기고 강제하라(주간 리포트에 노출된다):")
        _out(f"  python harness/phase.py force {target} --reason \"...\"")
        return 1

    stale = stale_session(root)
    if stale is not None:
        _out("")
        _out(f"[거부] {cur} → {target} — session.json 이 낡았다. 단계는 그대로 {cur} 다.")
        _out("")
        for line in stale.splitlines():
            _out(f"  {line}")
        _out("")
        _out(f"  python harness/phase.py session --goal \"…\" --did \"…\" --next \"…\"")
        _out(f"  python harness/phase.py enter {target}")
        return 1

    ck = record_transition(root, ctx, target, results, forced=False, reason=None, edge_legal=True)
    new_state = {
        "phase": target, "rq": ctx["rq"], "branch": ctx["branch"],
        "head_sha": ctx["sha"], "updated": st.iso_now(),
        "from": cur, "forced": False, "checkpoint": ck.relative_to(root).as_posix(),
    }
    st.write_phase_state(root, new_state)
    _out("")
    _out(f"[전이] {cur} → {target}")
    _out(f"  쓰기 허용 : {' '.join(st.phase_def(matrix, target).get('write_allow', []))}")
    _out(f"  다음      : {st.phase_def(matrix, target).get('exit_hint', '')}")
    _out(f"  체크포인트: {ck.relative_to(root).as_posix()}")
    return 0


def cmd_force(root: Path, ctx: dict, args) -> int:
    matrix, cur, target = ctx["matrix"], ctx["phase"], args.phase.upper()
    if target not in (matrix.get("phases") or {}):
        _out(f"[거부] 알 수 없는 단계: {target}")
        return 1
    legal = edge_for(matrix, cur, target) is not None
    ck = record_transition(root, ctx, target, [], forced=True, reason=args.reason, edge_legal=legal)
    st.write_phase_state(root, {
        "phase": target, "rq": ctx["rq"], "branch": ctx["branch"],
        "head_sha": ctx["sha"], "updated": st.iso_now(),
        "from": cur, "forced": True, "force_reason": args.reason,
        "checkpoint": ck.relative_to(root).as_posix(),
    })
    _out(f"[강제 전이] {cur} → {target}  (간선 {'합법' if legal else '비합법'}, 가드 미평가)")
    _out(f"  사유: {args.reason}")
    _out(f"  phase.jsonl 에 forced:true 로 박제됐고 주간 리포트 최상단에 노출된다.")
    _out(f"  force 비율 5% 초과는 에이전트 문제가 아니라 매트릭스가 틀렸다는 신호다.")
    _out(f"  체크포인트: {ck.relative_to(root).as_posix()}")
    return 0


def checkpoints_in_order(ck_dir: Path) -> list[Path]:
    """(ts, seq, 파일명) 순. **파일명만으로 정렬하면 안 된다** — 충돌 접미사
    'Z-1.json' 이 'Z.json' 보다 사전순으로 앞서고, 초 단위 ts 는 동률이 난다.
    둘 다 겪었고, 그 결과 '최신 체크포인트'가 시간순 마지막이 아니었다."""
    if not ck_dir.exists():
        return []
    def key(f: Path):
        data, status = st.read_json(f)
        d = data or {}
        return (str(d.get("ts") or ""), int(d.get("seq") or 0), f.name)
    return sorted(ck_dir.glob("*.json"), key=key)


def cmd_resume(root: Path, ctx: dict, args) -> int:
    s, matrix = ctx["session"], ctx["matrix"]
    _out("=" * 68)
    _out(f"RQ {ctx['rq']} · 단계 {ctx['phase']} · 브랜치 {ctx['branch']} @ {(ctx['sha'] or '')[:8]}")
    _out("=" * 68)
    _out(f"[왜] {s.get('goal') or '(미선언)'}")
    acc = s.get("acceptance")
    if acc:
        _out("[완료 조건]")
        for a in (acc if isinstance(acc, list) else [acc]):
            _out(f"  - {a}")
    for label, key in (("한 것", "done"), ("다음", "next"), ("열린 질문", "open_questions")):
        vals = s.get(key) or []
        if vals:
            _out(f"[{label}]")
            for v in (vals if isinstance(vals, list) else [vals]):
                _out(f"  - {v}")
    ck_root = st.state_dir(root) / st.CHECKPOINT_DIR / st.branch_slug(ctx["rq"])
    cks = checkpoints_in_order(ck_root)
    _out(f"[체크포인트] {len(cks)}건" + (f", 최신 {cks[-1].name}" if cks else ""))
    pd = st.phase_def(matrix, ctx["phase"])
    _out(f"[쓰기 허용] {' '.join(pd.get('write_allow', []))}")
    _out(f"[다음 전이] {pd.get('exit_hint', '')}")
    return 0


def _merge_list(existing, incoming, append: bool):
    """append=True 면 중복을 빼고 뒤에 붙이고, False 면 통째로 갈아끼운다."""
    incoming = [str(x) for x in (incoming or [])]
    if not append:
        return incoming
    out = list(existing or [])
    for item in incoming:
        if item not in out:
            out.append(item)
    return out


def cmd_session(root: Path, ctx: dict, args) -> int:
    """session.json 의 유일한 쓰기 경로.

    이 서브커맨드가 존재하는 이유: stop_state 훅이 "session.json 을 갱신하라"고
    차단하는데, Write 도구는 settings.json 이 막고 Bash 리다이렉트는 게이트가
    막는다. **순응할 길이 닫힌 게이트는 우회가 습관이 되고, 그 순간 장식이
    된다**(계획서 §8-5). 차단을 유지하면서 길을 여는 게 옳은 해법이다.

    불변식은 그대로다: .harness/state/ 의 writer 는 phase.py 하나다.
    """
    path = st.state_dir(root) / st.SESSION_FILE
    data, status = st.read_json(path)
    data = data or {"schema": 1}
    if status == "corrupt":
        _out(f"[경고] {path.name} 이 손상돼 있었다. 새로 쓴다 (이전 내용은 복구하지 않는다).")
        data = {"schema": 1}

    if args.from_json:
        try:
            raw = (sys.stdin.read() if args.from_json == "-"
                   else (root / args.from_json).read_text(encoding="utf-8"))
            incoming = json.loads(raw)
        except (OSError, json.JSONDecodeError) as e:
            _out(f"[거부] --from-json 을 읽지 못했다: {e}")
            return 1
        if not isinstance(incoming, dict):
            _out("[거부] --from-json 은 최상위가 객체(dict)여야 한다.")
            return 1
        incoming.pop("updated", None)  # 갱신일은 호출자가 정하지 않는다
        data.update(incoming)

    if args.rq or args.title:
        task = dict(data.get("task") or {})
        if args.rq:
            task["rq"] = args.rq
        if args.title:
            task["title"] = args.title
        data["task"] = task
    if args.goal:
        data["goal"] = args.goal
    if args.acceptance:
        data["acceptance"] = _merge_list(data.get("acceptance"), args.acceptance, False)
    if args.done:
        # done 만 누적이다 — 이번 세션의 성과는 지난 세션의 성과를 지우지 않는다
        data["done"] = _merge_list(data.get("done"), args.done, True)
    if args.next:
        data["next"] = _merge_list(data.get("next"), args.next, False)
    if args.open:
        data["open_questions"] = _merge_list(data.get("open_questions"), args.open, False)

    # updated 와 branch 는 CLI 가 찍는다. 사람이 손으로 쓰는 타임스탬프는 반드시
    # 거짓말을 한다 — 문서를 고치면서 날짜를 안 고치거나, 날짜만 고친다.
    data["updated"] = st.iso_now()
    if ctx["branch"]:
        data["branch"] = ctx["branch"]

    st.write_json_atomic(path, data)

    n_lines = len(path.read_text(encoding="utf-8").splitlines())
    _out(f"[세션 갱신] {path.relative_to(root).as_posix()} · updated={data['updated']}")
    _out(f"  RQ    : {(data.get('task') or {}).get('rq') or '(미설정)'}")
    _out(f"  goal  : {(data.get('goal') or '(미설정)')[:80]}")
    for label, key in (("done", "done"), ("next", "next"), ("open", "open_questions")):
        vals = data.get(key) or []
        if vals:
            _out(f"  {label:5s} : {len(vals)}건 · 최근 {str(vals[-1])[:70]}")
    if n_lines > SESSION_MAX_LINES:
        _out(f"  [예산 초과] {n_lines}줄 (계약 상한 {SESSION_MAX_LINES}). 길면 안 읽히고, 안 읽히는")
        _out(f"  계약은 없는 계약이다. 끝난 항목을 done 에서 걷어내거나 요약해 줄여라.")
        _out(f"  — 경고일 뿐 쓰기는 했다. 여기서 거부하면 순응할 길이 또 닫힌다.")
    else:
        _out(f"  분량  : {n_lines}줄 / 상한 {SESSION_MAX_LINES}")
    missing = [f for f in ("task.rq", "goal", "acceptance")
               if not (data.get("task", {}).get("rq") if f == "task.rq" else data.get(f))]
    if missing:
        _out(f"  [주의] session_declared 가드가 요구하는 필드가 비어 있다: {', '.join(missing)}")
        _out(f"         이 상태로는 PLAN → RED 전이가 거부된다.")
    return 0


def cmd_decide(root: Path, ctx: dict, args) -> int:
    """decisions.jsonl 의 유일한 쓰기 경로.

    이 파일은 어느 단계의 write_allow 에도 없었다 — 즉 커밋 대상 내구 기록인데
    쓸 수단이 없었다. 여기서 닫는다. 근거(--why)를 필수로 둔 이유는 하나다:
    **무엇을 결정했는지는 코드가 보여주지만, 왜는 아무 데도 안 남는다.**
    """
    rec = {
        "ts": st.iso_now(), "rq": ctx["rq"], "branch": ctx["branch"],
        "head_sha": ctx["sha"], "phase": ctx["phase"],
        "decision": args.decision, "rationale": args.why,
    }
    st.append_jsonl(st.state_dir(root) / st.DECISIONS_LOG, rec)
    _out(f"[결정 기록] {st.DECISIONS_LOG} (단계 {ctx['phase']}, RQ {ctx['rq']})")
    _out(f"  결정: {args.decision}")
    _out(f"  근거: {args.why}")
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # cp949 콘솔에서 한글이 깨진다
        except (AttributeError, OSError):
            pass

    ap = argparse.ArgumentParser(prog="phase.py", description="단계 상태 머신")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show", help="현재 단계·쓰기 허용 경로")
    sub.add_parser("why", help="왜 이 작업을 하는지 + 전이 이력")
    sub.add_parser("resume", help="재개 브리프 (상태 계약 이행부)")
    p_enter = sub.add_parser("enter", help="전이 (가드 평가)")
    p_enter.add_argument("phase")
    p_force = sub.add_parser("force", help="가드를 건너뛴 강제 전이 (사유 필수)")
    p_force.add_argument("phase")
    p_force.add_argument("--reason", required=True)

    p_sess = sub.add_parser("session", help="session.json 갱신 (상태 계약 이행)")
    p_sess.add_argument("--rq", help="task.rq")
    p_sess.add_argument("--title", help="task.title")
    p_sess.add_argument("--goal", help="왜 이 작업을 하는가 (무엇이 아니라)")
    p_sess.add_argument("--acceptance", action="append", help="완료 조건 (반복 가능, 교체)")
    p_sess.add_argument("--done", action="append", help="끝난 것 (반복 가능, 누적)")
    p_sess.add_argument("--next", action="append", help="다음 할 것 (반복 가능, 교체)")
    p_sess.add_argument("--open", action="append", help="열린 질문 (반복 가능, 교체)")
    p_sess.add_argument("--from-json", metavar="PATH", dest="from_json",
                        help="구조화 입력. '-' 이면 stdin. 최상위 키 단위 병합")

    p_dec = sub.add_parser("decide", help="decisions.jsonl 에 결정+근거 append")
    p_dec.add_argument("decision")
    p_dec.add_argument("--why", required=True, help="근거 — 이게 없으면 기록할 가치가 없다")

    args = ap.parse_args()

    root = st.project_root()
    matrix, risk, pstatus = st.load_policy(root)
    if pstatus != "ok":
        print(f"[치명] harness/policy/*.json 을 읽을 수 없다 ({pstatus}). "
              f"통제면이 고장난 상태에서는 전이를 판정하지 않는다.", file=sys.stderr)
        return 2

    ctx = context(root)
    ctx["matrix"], ctx["risk"] = matrix, risk
    if ctx["status"] in ("corrupt", "tampered"):
        print(f"[경고] phase.json 상태={ctx['status']} — IDLE로 취급한다(fail-closed). "
              f"phase.json은 phase.py만 쓴다.", file=sys.stderr)

    return {"show": cmd_show, "why": cmd_why, "enter": cmd_enter,
            "force": cmd_force, "resume": cmd_resume,
            "session": cmd_session, "decide": cmd_decide}[args.cmd](root, ctx, args)


if __name__ == "__main__":
    sys.exit(main())
