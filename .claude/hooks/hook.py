#!/usr/bin/env python3
"""훅 디스패처 — settings.json 이 참조하는 **유일한** 파이썬 경로 (제안, 미배선).

풀려는 문제는 종료 코드 충돌 하나다:

    python 은 스크립트 파일을 열지 못하면 **exit 2** 로 죽는다.
    훅 프로토콜에서 **exit 2 는 '도구 차단'** 이다.

따라서 settings.json 이 존재하지 않는 훅 파일을 가리키는 순간, 그 matcher 에
걸리는 모든 도구가 정책과 무관하게 막힌다. 훅 스크립트는 실행되지도 않으므로
스스로 방어할 방법이 없다. 2026-07-27 에 실제로 났다: `gate_spec_freeze.py` 를
지운 뒤 배선이 갱신되기 전까지 에이전트 전원의 Write/Edit 이 죽었다.

그때는 옛 matcher 가 `Write|Edit|MultiEdit` 이라 **Bash 로 탈출**할 수 있었다.
새 matcher 는 Bash 를 포섭한다 — 같은 일이 또 나면 세션 안에 복구 경로가 없다.

이 파일이 하는 일은 그 exit 2 를 exit 0 으로 바꾸는 것뿐이다:

    settings.json  →  python .claude/hooks/hook.py <handler>
                          ├ handler 파일 있음  → 실행하고 종료 코드를 그대로 전달
                          └ handler 파일 없음  → stderr 경고 + exit 0 (fail-OPEN)

부수 효과로 settings.json 의 파일 참조가 6개에서 1개로 준다. 남는 단일
실패점은 이 파일 자신인데, 이 파일은 의존성이 없고 바뀔 이유도 없다.

**trade-off (정직하게)**: 게이트 파손이 조용한 통과가 된다. 잠긴 저장소보다
낫다고 판단한 이유는 비대칭이다 — 통과는 로그에 남고 사후에 잡히지만, 잠금은
그것을 푸는 데 필요한 도구까지 같이 잠근다.
"""
import sys
from pathlib import Path


def warn(text: str) -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    sys.stderr.write(text + "\n")


def main() -> int:
    if len(sys.argv) < 2:
        warn("[hook] 핸들러 이름이 없다 — 통과시킨다. 사용법: hook.py <handler>")
        return 0

    name = sys.argv[1]
    if not name.endswith(".py"):
        name += ".py"
    target = Path(__file__).resolve().parent / Path(name).name  # 경로 이탈 차단

    if not target.is_file():
        warn(f"[hook] 핸들러가 없다: {target.name} — 판정하지 않고 통과시킨다(fail-OPEN).\n"
             f"       settings.json 의 배선과 .claude/hooks/ 의 실제 파일이 어긋났다.\n"
             f"       python harness/phase.py show 가 배선 경고를 함께 보여준다.")
        return 0

    # 같은 프로세스에서 실행한다 — stdin(훅 페이로드)이 그대로 살아 있어야 한다.
    import runpy
    try:
        runpy.run_path(str(target), run_name="__main__")
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        return code if isinstance(code, int) else 1
    except BaseException as exc:  # noqa: BLE001 — 좁히면 방어가 새어나간다
        import traceback
        warn(f"[hook] {target.name} 이 죽었다 ({type(exc).__name__}: {exc}) — "
             f"판정하지 않고 통과시킨다(fail-OPEN).\n" + traceback.format_exc(limit=3))
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
