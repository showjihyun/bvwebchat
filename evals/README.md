# 골든 eval 세트 [스텁②]

가볍게 시작한다. 무거운 eval 프레임워크·LLM judge 파이프라인은 만들지 않는다.

- **트랙 A** (`track-a-product.jsonl`): 제품 행동. 스택 확정 후 각 케이스를
  통합 테스트 코드로 구현하고 `verify` 필드에 테스트 파일 경로를 적는다.
  `blocked_on_spec` 케이스는 인터뷰 완료 후 then을 확정하고 todo로 바꾼다.
- **트랙 B** (`track-b-harness.jsonl`): 하네스 행동. CLAUDE.md·hook·skill을
  바꿨을 때 새 세션에서 태스크를 던져보고 rubric을 사람이 체크한다.
  (자동화하고 싶어지면 그때 LLM judge를 붙인다 — 지금은 수동으로 충분)

## 승격 루프

주간 회고에서 `.harness/logs/trajectory.jsonl`을 훑고,
이상했던 세션의 입력을 여기 새 케이스로 추가한다.
정답(then/rubric)은 반드시 사람이 쓴다 — 에이전트가 자기 정답을 쓰게 하지 않는다.
