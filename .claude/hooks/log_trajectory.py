#!/usr/bin/env python3
"""트래젝토리 로그 **schema 2** — Stop / SubagentStop hook.

schema 1 은 도구 호출 횟수만 셌다. 그것으로는 M6(도구 호출) 하나밖에 못
유도하고, 그마저 에이전트별 분해가 안 됐다. schema 2 가 더하는 것은 전부
"트레이스가 **유일한** 원천인 것"으로만 골랐다:

  agent · phase · rq · branch · head_sha  ← 나중에 로그를 조인할 축
  tokens                                   ← 예산. git 도 GitHub 도 모른다
  errors[] · blocked[]                     ← M8(게이트 차단)의 원료
  file_edit_counts                         ← T.07의 "동일 파일 몇 번 고쳤는지".
                                              같은 파일 6번 수정은 테스트가 전부
                                              초록이어도 헤매는 중이라는 신호이고,
                                              S2(테스트)로는 원리적으로 안 보인다

**M1·M2·M4·M5 를 여기 넣지 않는 이유**: 그것들의 원천은 git/GitHub 다.
전부 trajectory.jsonl 에 밀어넣으면 "센서 하나를 네 번 이름 바꾸기"가 된다(T.03).

Stop hook 은 반드시 0으로 끝난다 — 로깅이 세션 종료를 막으면 안 된다.
"""
import json
import sys
import time
from pathlib import Path

R1_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
LOG_FILE = ".harness/logs/trajectory.jsonl"


def summarize_transcript(path: str) -> dict:
    """트랜스크립트 1패스 요약. 어떤 실패에도 죽지 않는다 — 로그 훅이
    세션을 죽이는 건 관측을 위해 관측 대상을 부수는 짓이다."""
    s = {
        "turns": 0, "tool_calls": 0, "tools": {},
        "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
        "errors": [], "files_touched": [], "file_edit_counts": {},
    }
    id_to_tool: dict[str, str] = {}
    files: dict[str, int] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                s["turns"] += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = rec.get("message") or {}

                usage = msg.get("usage") or {}
                if isinstance(usage, dict):
                    s["tokens"]["input"] += usage.get("input_tokens") or 0
                    s["tokens"]["output"] += usage.get("output_tokens") or 0
                    s["tokens"]["cache_read"] += usage.get("cache_read_input_tokens") or 0
                    s["tokens"]["cache_write"] += usage.get("cache_creation_input_tokens") or 0

                content = msg.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "tool_use":
                        s["tool_calls"] += 1
                        name = block.get("name", "?")
                        s["tools"][name] = s["tools"].get(name, 0) + 1
                        if block.get("id"):
                            id_to_tool[block["id"]] = name
                        if name in R1_TOOLS:
                            ti = block.get("input") or {}
                            fp = ti.get("file_path") or ti.get("notebook_path")
                            if fp:
                                fp = str(fp).replace("\\", "/")
                                files[fp] = files.get(fp, 0) + 1
                    elif btype == "tool_result" and block.get("is_error"):
                        detail = block.get("content")
                        if isinstance(detail, list):
                            detail = " ".join(
                                str(b.get("text", "")) for b in detail if isinstance(b, dict))
                        s["errors"].append({
                            "tool": id_to_tool.get(block.get("tool_use_id"), "?"),
                            "detail": str(detail or "")[:300],
                        })
    except OSError:
        s["error"] = "transcript_unreadable"

    s["errors"] = s["errors"][-50:]  # 로그가 무한히 커지지 않게
    s["file_edit_counts"] = dict(sorted(files.items(), key=lambda kv: -kv[1])[:50])
    s["files_touched"] = sorted(files)[:200]
    return s


def gate_blocks(root: Path, session_id: str) -> list[dict]:
    """M8 의 원료. gate_phase.py 가 tools.jsonl 에 적어둔 차단 기록을 조인한다."""
    try:
        import _state as st
        rows = st.read_jsonl(root / ".harness/logs/tools.jsonl", limit=2000)
    except Exception:
        return []
    return [
        {"ts": r.get("ts"), "phase": r.get("phase"), "tool": r.get("tool"),
         "path": r.get("path") or r.get("target"), "pattern": r.get("pattern"),
         "warn_only": r.get("warn_only")}
        for r in rows
        if r.get("kind") == "gate_block" and (not session_id or r.get("session_id") == session_id)
    ][-100:]


def main() -> None:
    # stdin 을 UTF-8 바이트로 명시 디코딩 — Windows 한국어 로케일(cp949)에서
    # 한글 포함 페이로드의 디코딩 실패를 방지한다. (schema 1에서 이미 옳았다)
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "harness"))

    phase = rq = branch = head_sha = None
    try:
        import _state as st
        state, _ = st.read_phase_state(root)
        phase = state.get("phase")
        rq = ((st.read_session(root).get("task") or {}).get("rq")) or state.get("rq")
        branch, head_sha = st.head_info(root)
    except Exception:
        pass  # 하네스가 없거나 깨져도 트래젝토리는 남긴다

    event = payload.get("hook_event_name") or "Stop"
    session_id = payload.get("session_id") or ""
    record = {
        "schema": 2,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "event": event,
        "agent": payload.get("agent_type") or ("subagent" if event == "SubagentStop" else "main"),
        "session_id": session_id,
        "transcript_path": payload.get("transcript_path"),
        "phase": phase, "rq": rq, "branch": branch, "head_sha": head_sha,
    }

    tp = payload.get("transcript_path")
    summary = summarize_transcript(tp) if tp else {}
    record["turns"] = summary.get("turns", 0)
    record["tool_calls"] = summary.get("tool_calls", 0)
    record["tools"] = summary.get("tools", {})
    record["tokens"] = summary.get("tokens", {})
    record["errors"] = summary.get("errors", [])
    record["files_touched"] = summary.get("files_touched", [])
    record["file_edit_counts"] = summary.get("file_edit_counts", {})
    record["blocked"] = gate_blocks(root, session_id)
    if summary.get("error"):
        record["summary_error"] = summary["error"]

    try:
        path = root / LOG_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
