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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _state as st  # noqa: E402

GUARD_TIMEOUT_S = 900  # 전체 검증(vitest 포함)이 들어간다


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


def guard_grep_count(root: Path, spec: dict, var: dict) -> tuple[bool, str, dict]:
    target = root / spec["file"]
    if not target.exists():
        return False, f"파일이 없다: {spec['file']}", {}
    rx = re.compile(spec["pattern"])
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
    entry = {
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
        n += 1
        ck = ck_dir / f"{stamp}-{n}.json"
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
    cks = sorted(ck_root.glob("*.json")) if ck_root.exists() else []
    _out(f"[체크포인트] {len(cks)}건" + (f", 최신 {cks[-1].name}" if cks else ""))
    pd = st.phase_def(matrix, ctx["phase"])
    _out(f"[쓰기 허용] {' '.join(pd.get('write_allow', []))}")
    _out(f"[다음 전이] {pd.get('exit_hint', '')}")
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
            "force": cmd_force, "resume": cmd_resume}[args.cmd](root, ctx, args)


if __name__ == "__main__":
    sys.exit(main())
