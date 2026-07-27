#!/usr/bin/env python3
"""하네스 상태 계약 공용 라이브러리 (Plane 2/3 공통).

phase.py(유일한 writer)와 .claude/hooks/*(reader)가 함께 쓴다.

설계 제약 3가지 — 전부 실패 경험에서 나왔다:

1. **프로젝트 루트는 스크립트 위치에서 유도한다.** process.cwd()를 믿으면
   서브 에이전트가 다른 디렉터리에서 훅을 부르는 순간 상태 파일을 못 찾고
   조용히 fail-open 한다. 훅만 예외적으로 페이로드의 cwd에서 시작해 위로
   올라간다 — 그것도 '탐색 시작점'일 뿐 최종 판정은 마커 파일이 한다.
2. **stdlib만 쓴다.** 훅은 매 도구 호출마다 뜬다. pip 의존성이 하나라도
   생기면 다른 머신에서 훅이 죽고, 죽은 훅은 fail-open 이다.
3. **원자적 쓰기.** phase.json을 부분 기록한 채로 프로세스가 죽으면
   게이트가 손상 상태로 읽어 전 단계를 IDLE로 떨어뜨린다(fail-closed).
   같은 디렉터리에 임시 파일을 쓰고 os.replace 로 바꾼다.
"""
from __future__ import annotations

import hmac
import json
import os
import re
from hashlib import sha256
from pathlib import Path, PurePosixPath

# secrets · tempfile · datetime 은 함수 안에서 늦게 임포트한다. 게이트는 매 Write마다
# 뜨고 예산이 150ms인데 tempfile 은 shutil 을, secrets 는 random 을 끌고 온다.
# 이 셋은 '쓰기' 경로에서만 필요하고 게이트는 읽기만 한다.

# 루트 판별 마커. .git 은 worktree 에서 파일일 수 있어 exists() 로 본다.
ROOT_MARKERS = ("CLAUDE.md", ".git")

STATE_DIR = ".harness/state"
PHASE_FILE = "phase.json"
SESSION_FILE = "session.json"
KEY_FILE = ".key"
PHASE_LOG = "phase.jsonl"
DECISIONS_LOG = "decisions.jsonl"
CHECKPOINT_DIR = "checkpoints"

POLICY_MATRIX = "harness/policy/phase-matrix.json"
POLICY_RISK = "harness/policy/tool-risk.json"

DEFAULT_PHASE = "IDLE"  # 부재·손상 시의 fail-closed 기본값 (phase-matrix.json)


# ---------------------------------------------------------------- 루트 해석

def find_root(start: Path | None = None) -> Path | None:
    """start(기본값: 이 파일의 위치)에서 위로 올라가며 마커를 찾는다."""
    here = Path(start) if start else Path(__file__).resolve().parent
    try:
        here = here.resolve()
    except OSError:
        return None
    for cand in (here, *here.parents):
        if all((cand / m).exists() for m in ("CLAUDE.md",)):
            return cand
        if (cand / ".git").exists() and (cand / "harness").is_dir():
            return cand
    return None


def project_root() -> Path:
    """스크립트 자신의 위치 기준 루트. 실패하면 예외 — 조용히 넘어가지 않는다."""
    root = find_root()
    if root is None:
        raise SystemExit(
            "프로젝트 루트를 찾지 못했다 (CLAUDE.md 또는 .git+harness/ 가 있는 상위 디렉터리). "
            "저장소 밖에서 실행됐거나 harness/ 가 이동됐다."
        )
    return root


def state_dir(root: Path) -> Path:
    return root / STATE_DIR


# ---------------------------------------------------------------- 원자적 IO

def read_json(path: Path) -> tuple[dict | None, str]:
    """(데이터, 상태). 상태: ok | missing | corrupt"""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "corrupt"
    try:
        data = json.loads(raw.decode("utf-8", errors="strict"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, "corrupt"
    if not isinstance(data, dict):
        return None, "corrupt"
    return data, "ok"


def write_json_atomic(path: Path, data: dict) -> None:
    import tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def read_jsonl(path: Path, limit: int | None = None) -> list[dict]:
    """마지막 limit 줄만. 깨진 줄은 건너뛴다 — 로그 한 줄 때문에 죽지 않는다."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    if limit is not None:
        lines = lines[-limit:]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


# ------------------------------------------------------------------- 서명
# 목적: 에이전트가 Write 도구로 phase.json을 직접 고쳐 단계를 건너뛰는 것을
# 탐지한다. 예방이 아니다 — 키가 같은 디스크에 있으므로 결심한 우회는 막지
# 못한다. 막는 건 '실수로/편의로 손댄 상태'이고, 그것이 실제 실패 모드다.

def key_path(root: Path) -> Path:
    return state_dir(root) / KEY_FILE


def load_key(root: Path) -> bytes | None:
    try:
        return key_path(root).read_bytes().strip()
    except OSError:
        return None


def ensure_key(root: Path) -> bytes:
    kp = key_path(root)
    existing = load_key(root)
    if existing:
        return existing
    import secrets
    kp.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_hex(32).encode("ascii")
    kp.write_bytes(key)
    try:
        os.chmod(kp, 0o600)
    except OSError:
        pass  # Windows에서는 무의미 — 실패해도 진행한다
    return key


def _canonical(data: dict) -> bytes:
    body = {k: v for k, v in data.items() if k != "sig"}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign(data: dict, key: bytes) -> str:
    return hmac.new(key, _canonical(data), sha256).hexdigest()


def verify(data: dict, key: bytes | None) -> bool:
    if key is None:
        return False
    got = data.get("sig")
    if not isinstance(got, str):
        return False
    return hmac.compare_digest(got, sign(data, key))


def read_phase_state(root: Path) -> tuple[dict, str]:
    """(상태, 판정). 판정: ok | missing | corrupt | tampered

    missing 은 '하네스를 아직 안 쓴다'이고 corrupt/tampered 는 '누가 손댔다'다.
    호출자가 이 둘을 구분할 수 있어야 fail-open/fail-closed 를 나눠 쓸 수 있다.
    """
    data, status = read_json(state_dir(root) / PHASE_FILE)
    if status != "ok" or data is None:
        return {"phase": DEFAULT_PHASE}, status
    if not verify(data, load_key(root)):
        return {"phase": DEFAULT_PHASE, "_untrusted": data}, "tampered"
    return data, "ok"


def write_phase_state(root: Path, data: dict) -> None:
    key = ensure_key(root)
    body = {k: v for k, v in data.items() if k != "sig"}
    body["sig"] = sign(body, key)
    write_json_atomic(state_dir(root) / PHASE_FILE, body)


def read_session(root: Path) -> dict:
    data, _ = read_json(state_dir(root) / SESSION_FILE)
    return data or {}


# --------------------------------------------------------------- glob 매칭

_GLOB_CACHE: dict[str, re.Pattern] = {}


def _glob_to_regex(pat: str) -> re.Pattern:
    """쓰기 매트릭스용 glob → regex.

    fnmatch를 쓰지 않는 이유: fnmatch의 '*'는 '/'까지 먹는다. 그러면
    'src/*'가 'src/a/b/c.ts'에 매칭돼 매트릭스가 의도보다 넓어진다.
    쓰기 허용 집합이 의도보다 넓은 것은 게이트가 없는 것과 같다.
    """
    cached = _GLOB_CACHE.get(pat)
    if cached is not None:
        return cached
    i, n, out = 0, len(pat), ["^"]
    while i < n:
        c = pat[i]
        if c == "*":
            j = i
            while j < n and pat[j] == "*":
                j += 1
            star_count = j - i
            if star_count >= 2:
                if j < n and pat[j] == "/":
                    out.append("(?:[^/]+/)*")  # '**/' → 디렉터리 0개 이상
                    i = j + 1
                    continue
                out.append(".*")               # 끝의 '**' → 나머지 전부
                i = j
                continue
            out.append("[^/]*")
            i = j
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    out.append("$")
    rx = re.compile("".join(out))
    _GLOB_CACHE[pat] = rx
    return rx


def path_matches(rel_posix: str, pattern: str) -> bool:
    return _glob_to_regex(pattern).search(rel_posix) is not None


def first_match(rel_posix: str, patterns: list[str]) -> str | None:
    """매칭된 패턴 자체를 돌려준다 — 에러 메시지에 '무엇이 판정했는지'를 적기 위해."""
    for p in patterns or []:
        if path_matches(rel_posix, p):
            return p
    return None


def rel_path(root: Path, raw: str) -> str | None:
    """절대/상대 경로를 루트 기준 POSIX 상대경로로. 루트 밖이면 None."""
    if not raw:
        return None
    p = Path(raw)
    try:
        if not p.is_absolute():
            p = root / p
        # resolve()는 심볼릭 링크·'..' 를 정규화한다. 존재하지 않는 파일도 OK.
        rp = p.resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    return rp.as_posix()


# --------------------------------------------------------------- 보간

_VAR_RE = re.compile(r"\$\{(\w+)\}")


def interpolate(text: str, variables: dict) -> str:
    """${rq} / ${branch_slug} / ${n} 치환. 미정의 변수는 그대로 둔다 —
    조용히 빈 문자열로 바꾸면 'src/**' 가 '**' 가 되는 식의 사고가 난다."""
    def sub(m: re.Match) -> str:
        v = variables.get(m.group(1))
        return str(v) if v is not None else m.group(0)
    return _VAR_RE.sub(sub, text)


def branch_slug(branch: str) -> str:
    """브랜치명을 파일명 안전한 슬러그로. feat/RQ-01-x → feat-RQ-01-x"""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", branch or "").strip("-") or "unknown"


# ------------------------------------------------------- git (서브프로세스 없이)
# 게이트는 서브프로세스를 띄우면 안 된다(≤150ms). .git 을 직접 읽는다.

def head_info(root: Path) -> tuple[str, str]:
    """(branch, sha). 실패하면 ('', '') — 없다고 죽지 않는다."""
    git = root / ".git"
    try:
        if git.is_file():  # worktree: 'gitdir: <path>'
            line = git.read_text(encoding="utf-8", errors="replace").strip()
            git = Path(line.split(":", 1)[1].strip()) if ":" in line else git
        head = (git / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return "", ""
    if not head.startswith("ref:"):
        return "", head  # detached HEAD
    ref = head.split(":", 1)[1].strip()
    branch = ref.split("refs/heads/", 1)[-1]
    try:
        return branch, (git / ref).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        pass
    try:  # packed-refs 폴백
        for line in (git / "packed-refs").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) == 2 and parts[1] == ref:
                return branch, parts[0]
    except OSError:
        pass
    return branch, ""


# --------------------------------------------------------------- 정책 로딩

def load_policy(root: Path) -> tuple[dict | None, dict | None, str]:
    """(matrix, risk, 상태). 상태: ok | missing | corrupt

    missing = 하네스 미설치 → 호출자는 fail-OPEN 해야 한다.
    corrupt = 설치됐는데 깨졌다 → 통제면 고장이므로 시끄럽게 실패한다.
    """
    mpath, rpath = root / POLICY_MATRIX, root / POLICY_RISK
    if not mpath.exists() and not rpath.exists():
        return None, None, "missing"
    matrix, ms = read_json(mpath)
    risk, rs = read_json(rpath)
    if ms == "missing" and rs == "missing":
        return None, None, "missing"
    if ms != "ok" or rs != "ok":
        return None, None, "corrupt"
    return matrix, risk, "ok"


def phase_def(matrix: dict, phase: str) -> dict:
    return (matrix.get("phases") or {}).get(phase) or {}


def is_warn_only(matrix: dict, phase: str) -> bool:
    return phase in ((matrix.get("enforce") or {}).get("warn_only") or [])


def hook_wiring_problems(root: Path) -> list[str]:
    """settings.json 이 참조하는 훅 스크립트가 실재하는지 본다.

    이 검사가 존재하는 이유는 **종료 코드 충돌** 하나다. 파이썬은 스크립트
    파일을 열지 못하면 exit 2 로 죽는데, 훅 프로토콜에서 exit 2 는 '도구
    차단'이다. 따라서 settings.json 이 없는 파일을 가리키는 순간, 그 matcher 에
    걸리는 모든 도구가 정책과 무관하게 막힌다. 훅 스크립트는 실행조차 되지
    않으므로 **스스로는 절대 방어할 수 없다** — 밖에서 보는 눈이 필요하다.

    실측(2026-07-27): 파일 부재 exit 2(차단) / 구문 오류·런타임 예외 exit 1
    (비차단) / 인터프리터 부재 exit 127(비차단). 즉 위험한 건 '부재' 하나뿐이다.

    ⚠️ 같은 판정을 scripts/hooks-selftest.mjs 도 내린다. **중복은 의도된 것**이다:
    이쪽은 세션 시작 다이제스트·phase.py show 에서 뜨는 빠른 피드백(왼쪽)이고,
    저쪽은 CI·harness-audit 에서 머지를 막는 게이트(오른쪽)다. 배치가 다르므로
    하나로 합치면 둘 중 하나의 자리가 없어진다.

    남는 부채: '디스패처'를 판별하는 지식(현재는 이름이 hook.py 라는 것)이 두
    구현에 따로 박혀 있다. **디스패처를 하나 더 만들거나 이름을 바꾸면 양쪽을
    같이 고쳐야 한다.** 지금 공유 설정으로 빼지 않는 이유는 디스패처가 하나뿐이고
    늘 이유가 없어서다 — 쓰이지 않을 추상화를 미리 만드는 비용이 더 크다.
    그 전제가 깨지는 날 harness/policy/ 에 dispatchers 목록을 두고 양쪽이 읽게 하라.
    """
    data, status = read_json(root / ".claude/settings.json")
    if status != "ok" or data is None:
        return []
    problems = []
    for event, groups in ((data.get("hooks") or {})).items():
        for group in groups if isinstance(groups, list) else []:
            for hook in (group or {}).get("hooks") or []:
                cmd = str((hook or {}).get("command") or "")
                tokens = cmd.replace('"', " ").replace("'", " ").split()
                for i, token in enumerate(tokens):
                    if token.endswith((".py", ".mjs", ".js", ".sh")):
                        if not (root / token).exists():
                            problems.append(f"{event}: {token} 없음")
                            continue
                        # 디스패처 간접층을 따라간다. 'hook.py gate_phase' 는
                        # hook.py 만 보면 통과하지만 실제로 판정을 내는 건
                        # gate_phase.py 다. 그게 사라지면 디스패처가 설계대로
                        # fail-OPEN 하고, 게이트가 꺼진 걸 아무도 모르게 된다.
                        if PurePosixPath(token).name == "hook.py" and i + 1 < len(tokens):
                            handler = tokens[i + 1]
                            if not handler.endswith(".py"):
                                handler += ".py"
                            target = Path(token).parent / PurePosixPath(handler).name
                            if not (root / target).exists():
                                problems.append(
                                    f"{event}: 디스패처 핸들러 {target.as_posix()} 없음 "
                                    f"(hook.py 는 있지만 판정을 내는 쪽이 없다 → 조용히 fail-OPEN)")
    return problems


def utc_stamp() -> str:
    """파일명 안전한 ISO 8601 basic + 밀리초 (콜론 없음 — Windows 파일명 제약).

    밀리초를 넣는 이유는 정렬이다. 초 단위였을 때 같은 초의 전이 3건이
    충돌 접미사('-1','-2')를 받았는데, '-'(0x2D) 가 '.'(0x2E) 보다 작아
    'Z-1.json' 이 'Z.json' 보다 앞서 정렬됐다. 그 결과 '최신 체크포인트'가
    시간순 마지막이 아니게 되고, 파일명으로 정답지를 고르는 resume-test 가
    낡은 상태를 기준으로 채점했다. 전부 숫자로 끝나면 이 문제가 사라진다.
    """
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y%m%dT%H%M%S") + f"{now.microsecond // 1000:03d}" + "Z"


def bump_stamp(stamp: str, ms: int) -> str:
    """스탬프를 ms 밀리초 뒤로 민다.

    같은 밀리초에 두 번 기록될 때 'Z-1.json' 같은 접미사를 붙이면 정렬이
    깨진다 — '-'(0x2D) 가 '.'(0x2E) 보다 작아 접미사 붙은 쪽이 앞선다.
    이름을 끝까지 순수 숫자로 유지하는 편이 소비자에게 안전하다: 파일명
    정렬 == 시간순이라는 불변식이 유지된다.
    """
    import datetime
    base = datetime.datetime.strptime(stamp[:-1], "%Y%m%dT%H%M%S%f") if "." in stamp else \
        datetime.datetime(
            int(stamp[0:4]), int(stamp[4:6]), int(stamp[6:8]),
            int(stamp[9:11]), int(stamp[11:13]), int(stamp[13:15]),
            int(stamp[15:18]) * 1000)
    out = base + datetime.timedelta(milliseconds=ms)
    return out.strftime("%Y%m%dT%H%M%S") + f"{out.microsecond // 1000:03d}" + "Z"


def iso_now() -> str:
    """밀리초까지 — 초 단위면 같은 초의 기록들이 ts 로도 구분되지 않는다."""
    import datetime
    return (datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z"))
