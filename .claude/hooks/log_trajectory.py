#!/usr/bin/env python3
"""[스텁①] 트래젝토리 로그 — Stop hook.

매 응답 종료 시 세션 요약 한 줄을 .harness/logs/trajectory.jsonl에 append.
목적: 주간 회고 때 "이상했던 세션"을 찾아 골든 케이스로 승격하는 원료.
깊은 관측성(OTel 등)은 의도적으로 생략 — 필요해지면 그때 확장한다.
"""
import json
import sys
import time
from pathlib import Path

LOG_DIR = Path(".harness/logs")
LOG_FILE = LOG_DIR / "trajectory.jsonl"


def summarize_transcript(path: str) -> dict:
    """트랜스크립트에서 도구 사용 횟수 등 가벼운 요약만 추출. 실패해도 죽지 않는다."""
    counts: dict = {"turns": 0, "tool_calls": 0, "tools": {}}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                counts["turns"] += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = rec.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            counts["tool_calls"] += 1
                            name = block.get("name", "?")
                            counts["tools"][name] = counts["tools"].get(name, 0) + 1
    except OSError:
        counts["error"] = "transcript_unreadable"
    return counts


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        payload = {}

    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "session_id": payload.get("session_id"),
        "transcript_path": payload.get("transcript_path"),
    }
    tp = payload.get("transcript_path")
    if tp:
        record["summary"] = summarize_transcript(tp)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # Stop hook은 0으로 종료해야 세션 종료를 막지 않는다.
    sys.exit(0)


if __name__ == "__main__":
    main()
