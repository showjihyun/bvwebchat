#!/usr/bin/env node
/**
 * scripts/resume-test.mjs — L3 졸업 시험 (골든 GB-06).
 *
 * 계약(T.04): **새 세션이 5분 안에 "무엇을 왜 했고 다음은 무엇인지" 복원한다.**
 *
 * 이 스크립트의 핵심 설계는 하나다:
 *
 * > **정답지를 사람이 쓰지 않는다 — 체크포인트 파일 자체가 정답지다.**
 *
 * 사람이 정답지를 쓰면 (a) 상태가 바뀔 때마다 정답지가 낡고 (b) 낡은 정답지로
 * 채점한 결과는 상태 계약이 아니라 정답지의 나이를 잰다. 체크포인트를 정답지로
 * 쓰면 CI에서 몇 번이고 반복 실행할 수 있고 정답지가 낡는 일이 원리적으로 없다.
 *
 * 절차: 체크포인트 선택 → `git worktree` 격리 → (cold면 다이제스트 무력화)
 *       → `claude -p` 헤드리스 5문항 → 결정론 채점 4문항 + evaluator 판정 1문항.
 *
 *   node scripts/resume-test.mjs --cold     다이제스트 없음 · 라이브 커서 없음 ← **계약**
 *   node scripts/resume-test.mjs --warm     다이제스트 + 라이브 커서 (진단, 시간 기준 없음)
 *   node scripts/resume-test.mjs --at 20260727T015105Z   특정 체크포인트로
 *   node scripts/resume-test.mjs --dry-run  LLM 없이 준비 상태·정답지만 확인
 *   node scripts/resume-test.mjs --cold --json   기계 판독용 (사람 출력은 stderr)
 *   node scripts/resume-test.mjs --cold --keep   워크트리를 남긴다 (디버깅)
 *
 * **PASS 기준 (cold 만이 계약이다)**  5/5 · 읽은 파일 ≤7 · ≤5분
 *
 * ## warm 에 시간 기준이 없는 이유
 * T.04 계약은 "새 세션이 5분 안에 무엇을 왜 했고 다음은 무엇인지 복원한다"이고,
 * **cold 가 정확히 그것을 잰다.** warm 은 SessionStart 다이제스트라는 *편의 기능*이
 * 작동하는지 보는 진단이다. 편의를 계약으로 승격하면 계약이 흐려진다.
 *
 * 실측이 이를 뒷받침한다(2026-07-27): **더 많은 일을 하는 cold 가 1.28분인데
 * warm 이 1.88분**이었다. 병목은 상태 복원이 아니라 CLI 기동 + 모델 지연이다.
 * 그 조건에서 ≤1분은 도달 불가능한 값이고, **도달 불가능한 기준은 기준이 아니라
 * 상시 실패다.** 상시 실패는 상시 WARN 과 같은 병 — 다음 실패를 무시하게 만드는
 * 훈련이다. 숫자를 다른 임의의 숫자(3분)로 바꾸는 것도 답이 아니다. 그 숫자가
 * 무엇을 보장하는지 아무도 설명할 수 없기 때문이다.
 * → warm 은 시간을 **계측만 하고 판정하지 않는다.** 정답률·파일 수는 그대로 판정한다.
 *
 * 종료 코드 (계약 — 호출자가 구분해야 한다):
 *   0  PASS
 *   1  FAIL — 채점 결과가 기준 미달. 상태 계약이 얇다는 뜻이다
 *   2  실행 불가 — claude CLI 부재/미인증/판정 불가. **PASS도 FAIL도 아니다**
 *   3  준비 불가 — 체크포인트 없음 · worktree 실패 (환경 결함, 계약 결함이 아니다)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const CHECKPOINT_ROOT = join(ROOT, '.harness/state/checkpoints');
const EVALUATOR_AGENT = join(ROOT, '.claude/agents/evaluator.md');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_UNAVAILABLE = 2;
const EXIT_UNPREPARED = 3;

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/resume-test.mjs [--cold|--warm] [--at <ISO스탬프>] [--dry-run] [--json] [--keep] [--verbose] [--self-test]');
  console.log('  --self-test  LLM 없이 "읽은 파일" 계수만 잰다 — 플래그 값을 파일로 세지 않는지');
  console.log('  --cold  (기본) SessionStart 다이제스트 무력화 + 라이브 커서 없음 — 커밋된 상태 파일만으로 복원');
  console.log('  --warm  다이제스트 + 라이브 커서 복사 — 진단. 시간은 계측만 하고 판정하지 않는다');
  console.log('종료 코드: 0 PASS · 1 FAIL · 2 실행 불가(CLI 부재/미인증) · 3 준비 불가(체크포인트 없음)');
  process.exit(EXIT_PASS);
}
const WARM = argv.includes('--warm');
const COLD = !WARM;
const DRY_RUN = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('--verbose');
const AT = (() => {
  const i = argv.indexOf('--at');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// PASS 기준 — cold 와 warm 은 서로 다른 것을 재므로 기준도 다르다.
// warm 의 maxMinutes 가 null 인 것이 설계다: 시간은 계측하되 판정하지 않는다(위 주석 참조).
const BAR = COLD
  ? { minScore: 5, maxFiles: 7, maxMinutes: 5 }
  : { minScore: 5, maxFiles: 12, maxMinutes: null };

/** --json 일 때 stdout은 JSON 전용이다. 사람 출력은 stderr로 보낸다. */
function say(...a) {
  if (JSON_OUT) console.error(...a);
  else console.log(...a);
}

// ── git ─────────────────────────────────────────────────────────────────────
function git(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: ((r.stderr || '') + (r.error?.message || '')).trim() };
}

// ── 체크포인트 = 정답지 ─────────────────────────────────────────────────────
/** 모든 RQ 디렉터리를 훑어 (ts, path) 목록을 만든다. 파일명은 ISO basic이라 사전순 = 시간순이다. */
function listCheckpoints() {
  if (!existsSync(CHECKPOINT_ROOT)) return [];
  const out = [];
  for (const rqDir of readdirSync(CHECKPOINT_ROOT, { withFileTypes: true })) {
    if (!rqDir.isDirectory()) continue;
    const dir = join(CHECKPOINT_ROOT, rqDir.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const path = join(dir, f);
      let data;
      try {
        data = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue; // 깨진 체크포인트 한 건 때문에 시험 자체가 멈추면 안 된다
      }
      // 파일명은 <ISO basic>[-<충돌순번>].json 이다. 충돌 순번은 **나중에 쓰인 것일수록 크다** —
      // 사전순 정렬은 '-1' 을 '.json' 보다 앞에 놓아 최신 체크포인트를 놓친다. 실측으로 물렸다.
      const m = /^(.+?)(?:-(\d+))?\.json$/.exec(f);
      out.push({ path, rel: path.slice(ROOT.length + 1).replace(/\\/g, '/'), name: f, rq: rqDir.name, ts: data.ts || '', stamp: m ? m[1] : f, seq: m && m[2] ? Number(m[2]) : 0, data });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts) || a.stamp.localeCompare(b.stamp) || a.seq - b.seq);
}

// ── 답안 대조 (결정론) ──────────────────────────────────────────────────────
// 자유 서술을 결정론적으로 채점해야 한다. LLM 판정을 쓰면 정답지가 사람 손을
// 떠난 이득이 사라진다(반복 실행 시 판정이 흔들린다). 그래서 두 신호를 쓴다:
//
//   1) **앵커** — 기대 문자열의 라틴/숫자 토큰(파일명·식별자·단계명·수치).
//      언어와 무관하게 변별력이 크고, 맞히려면 실제로 그 파일을 읽어야 한다.
//   2) **한글 문자 바이그램 Dice** — 앵커가 없는 순한글 문장용 보조 신호.
//      형태소 분석기 없이(=의존성 없이) 한국어 유사도를 재는 실용적 방법이다.
//
// 임계값은 보수적으로 잡았다. 느슨하면 "아무 말이나 하면 통과"가 되고,
// 빡빡하면 정답을 다르게 표현한 답이 떨어진다. 후자가 덜 위험하므로 후자 쪽이다.
const ANCHOR_RE = /[A-Za-z0-9][A-Za-z0-9._/#-]{2,}/g;
const ANCHOR_STOP = new Set(['the', 'and', 'for', 'not', 'with', 'this', 'that', 'json', 'md', 'http', 'https']);

function nfc(s) {
  return String(s ?? '').normalize('NFC');
}
function norm(s) {
  return nfc(s).toLowerCase().replace(/\s+/g, ' ').trim();
}
function anchorsOf(s) {
  const found = norm(s).match(ANCHOR_RE) || [];
  return [...new Set(found.filter((t) => !ANCHOR_STOP.has(t) && !/^\d+$/.test(t)))];
}
function bigrams(s) {
  const t = norm(s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/**
 * 기대 문자열 하나가 답안(문자열 또는 문자열 배열) 어딘가에 있는가.
 * 배열이면 항목별 최고점과 전체 연결 문자열 점수 중 큰 쪽을 쓴다 —
 * 답을 3개로 쪼갰든 한 문단으로 썼든 같은 내용이면 같은 판정이어야 한다.
 */
function matchOne(expected, answer) {
  const cands = Array.isArray(answer) ? [...answer.map(nfc), answer.map(nfc).join(' ')] : [nfc(answer)];
  const anchors = anchorsOf(expected);
  let best = { ok: false, dice: 0, hits: 0, total: anchors.length, cand: '' };
  for (const c of cands) {
    const lc = norm(c);
    const hits = anchors.filter((a) => lc.includes(a)).length;
    const d = dice(expected, c);
    // 앵커가 2개 이상이면 앵커가 1차 신호다. 그 이하면 바이그램만 남는다.
    const ok = anchors.length >= 2 ? hits / anchors.length >= 0.5 || d >= 0.45 : d >= 0.35;
    if (ok || d > best.dice || hits > best.hits) best = { ok: ok || best.ok, dice: Math.max(d, best.dice), hits: Math.max(hits, best.hits), total: anchors.length, cand: c.slice(0, 120) };
  }
  return best;
}

/** 기대 목록 전체 대조. needAll=true면 전부 맞아야 1점. */
function matchList(expectedList, answer, needAll) {
  const items = (expectedList || []).map((e) => ({ expected: nfc(e), ...matchOne(e, answer) }));
  const hit = items.filter((i) => i.ok).length;
  const ok = items.length === 0 ? true : needAll ? hit === items.length : hit / items.length >= 0.6;
  return { ok, hit, total: items.length, items };
}

// ── claude -p 실행 ──────────────────────────────────────────────────────────
function claudeOnPath() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (r.error) return { ok: false, why: `claude 실행 파일을 찾을 수 없다 (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { ok: false, why: `claude --version 이 exit ${r.status}` };
  return { ok: true, version: (r.stdout || '').trim().split('\n')[0] };
}

const AUTH_HINT = /(not authenticated|unauthenticated|login|api key|apikey|credit balance|invalid.*key|oauth|429|rate.?limit)/i;

/** stream-json 한 줄씩 파싱. 깨진 줄은 건너뛴다 — 로그 한 줄로 시험 전체가 죽지 않는다. */
function parseStream(stdout) {
  const events = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* 부분 출력 — 무시 */
    }
  }
  return events;
}

/** 도구 호출에서 "읽은 파일"을 센다. 셸로 세탁한 읽기(cat/head/…)도 함께 잡는다. */
const SHELL_READ_RE = /(?:^|[|;&]\s*)(?:cat|head|tail|less|more|type|Get-Content|sed\s+-n)\s+([^|;&>]+)/gi;

/**
 * 플래그의 **값**은 파일이 아니다 — `tail -n 6 x` 의 `6` 이 파일로 세어지면
 * 예산 검사가 대상이 아닌 것을 잰다. 2026-08-10 GB-06 이 정확히 이것으로 떨어졌다:
 * 실파일 6개인데 `6`·`3` 이 섞여 8/7 로 FAIL 이 났다 (`harness/recurrence.md` R5·R15 계열).
 *
 * **`-Path`·`-LiteralPath` 는 넣지 않는다** — 그 값은 진짜 파일이라, 빼면
 * 과소 계수가 되어 얇은 상태 계약이 통과한다. 여기 있는 것은 값이 경로일 수
 * **없는** 플래그뿐이다.
 */
const VALUE_FLAGS = new Set(
  ['-n', '-c', '--lines', '--bytes', '-tail', '-totalcount', '-first', '-last', '-head', '-skip', '-encoding', '-delimiter'],
);
/** `sed -n` 의 스크립트 인자(`3,10p` · `$p` · `1,$p`). 주소는 경로가 아니다. */
const SED_SCRIPT_RE = /^[\d,$]+[a-z]$/i;

/** 셸 명령 하나에서 **읽은 파일**만 뽑는다. 순수 함수 — `--self-test` 가 이것을 잰다. */
function shellReadFiles(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(SHELL_READ_RE)) {
    const toks = m[1].trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      if (tok.startsWith('-')) continue;
      if (VALUE_FLAGS.has(String(toks[i - 1] || '').toLowerCase())) continue;
      const bare = tok.replace(/^["']|["']$/g, '');
      if (/^\d+$/.test(bare)) continue;
      if (SED_SCRIPT_RE.test(bare)) continue;
      out.push(relOf(bare));
    }
  }
  return out;
}
function collectTools(events) {
  const files = new Set();
  const searches = [];
  const calls = [];
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    for (const block of ev.message?.content || []) {
      if (block.type !== 'tool_use') continue;
      const name = block.name;
      const input = block.input || {};
      calls.push(name);
      if (name === 'Read' || name === 'NotebookRead') {
        if (input.file_path) files.add(relOf(input.file_path));
      } else if (name === 'Glob' || name === 'Grep') {
        searches.push(`${name}(${input.pattern || ''})`);
      } else if (name === 'Bash' || name === 'PowerShell') {
        const cmd = String(input.command || '');
        // phase.py 는 phase.json·session.json·phase.jsonl 을 한 번에 읽는다.
        // 상태 파일 묶음 1건으로 센다 — 셸을 쓴다고 예산이 공짜가 되면 안 된다.
        if (/harness[/\\]phase\.py/.test(cmd)) files.add('harness/phase.py(상태 파일 묶음)');
        for (const f of shellReadFiles(cmd)) files.add(f);
      }
    }
  }
  return { files: [...files], searches, calls };
}
function relOf(p) {
  const s = String(p).replace(/\\/g, '/');
  const root = ROOT.replace(/\\/g, '/');
  if (s.startsWith(root)) return s.slice(root.length + 1);
  const i = s.lastIndexOf('/.harness/');
  if (i >= 0) return s.slice(i + 1);
  return s;
}

// ── 자기시험 ────────────────────────────────────────────────────────────────
// 여기까지는 선언뿐이라 부작용 없이 빠져나갈 수 있다.
// **양쪽을 다 넣는다**: 세어야 하는 것(과소 계수 = 얇은 계약이 통과)과
// 세면 안 되는 것(과대 계수 = 2026-08-10 GB-06 의 오판). 한쪽만 넣으면
// 반대 방향으로 고치면서 통과한다 — `harness/recurrence.md` R2 가 그 형상이다.
const SELF_TEST_CASES = [
  // [명령, 반드시 세어야 할 것, 절대 세면 안 되는 것]
  ['cat README.md', ['README.md'], []],
  ['head -n 3 .harness/state/decisions.jsonl', ['.harness/state/decisions.jsonl'], ['3']],
  ['tail -n 6 .harness/state/phase.jsonl', ['.harness/state/phase.jsonl'], ['6']],
  ["sed -n '3,10p' docs/progress.md", ['docs/progress.md'], ['3,10p']],
  ['tail -6 .harness/state/phase.jsonl', ['.harness/state/phase.jsonl'], ['-6', '6']],
  ['Get-Content -Path docs/progress.md', ['docs/progress.md'], []],
  ['Get-Content -Tail 5 docs/progress.md', ['docs/progress.md'], ['5']],
  ['cat a.md b.md', ['a.md', 'b.md'], []],
  ['cat x.md | head -n 2', ['x.md'], ['2']],
  ['git status', [], ['status']],
];
if (argv.includes('--self-test')) {
  let bad = 0;
  for (const [cmd, must, mustNot] of SELF_TEST_CASES) {
    const got = shellReadFiles(cmd);
    const missing = must.filter((f) => !got.includes(f));
    const leaked = mustNot.filter((f) => got.includes(f));
    const ok = missing.length === 0 && leaked.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cmd}`);
    if (!ok) console.log(`        기대 포함 ${JSON.stringify(must)} · 금지 ${JSON.stringify(mustNot)} · 실제 ${JSON.stringify(got)}`);
  }
  console.log(
    bad
      ? `\n재개 시험 자기시험 실패 ${bad}건 / ${SELF_TEST_CASES.length}건 — 파일 계수가 대상이 아닌 것을 센다.`
      : `\n재개 시험 자기시험 ${SELF_TEST_CASES.length}건 통과 (읽은 파일 계수 — 양성 ${SELF_TEST_CASES.filter((c) => c[1].length).length} · 음성 ${SELF_TEST_CASES.filter((c) => c[2].length).length}).`,
  );
  process.exit(bad ? EXIT_FAIL : EXIT_PASS);
}

function lastAssistantText(events) {
  let text = '';
  for (const ev of events) {
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
    }
    if (ev.type === 'result' && typeof ev.result === 'string') text += `${ev.result}\n`;
  }
  return text;
}

/** 마지막 ```json 코드블록. 없으면 마지막 균형 잡힌 { … } 를 시도한다. */
function extractJson(text) {
  const fences = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const raw of fences.reverse()) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') return v;
    } catch {
      /* 다음 후보 */
    }
  }
  const start = String(text).lastIndexOf('{');
  if (start >= 0) {
    for (let end = String(text).length; end > start; end--) {
      try {
        const v = JSON.parse(String(text).slice(start, end));
        if (v && typeof v === 'object') return v;
      } catch {
        /* 계속 줄인다 */
      }
    }
  }
  return null;
}

// ── 5문항 (고정) ────────────────────────────────────────────────────────────
const QUESTIONS = [
  '지금 무슨 RQ의 어느 단계인가?',
  '무엇을 왜 했는가? — "왜"가 핵심이다. 무엇을 했는지는 git이 이미 안다.',
  '다음 행동 3개는 무엇인가?',
  '무엇이 막고 있나? (열린 질문·미결 사항)',
  '완료 판정 기준은 무엇인가?',
];

const PROMPT = [
  '이전 세션의 대화 기록이 없다. 이 저장소의 **상태 파일**만으로 아래 5문항에 답하라.',
  '',
  ...QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
  '',
  '규칙:',
  '- 저장소를 전부 훑어 추측으로 맞히는 것은 통과가 아니다. **읽은 파일 수가 함께 채점된다** (예산 7개).',
  '- 상태 계약은 `.harness/state/` 에 있다. 커밋되는 내구 기록은 checkpoints/ · phase.jsonl · decisions.jsonl 이다.',
  '- 코드를 고치거나 파일을 쓰지 마라. 읽고 답하는 것이 전부다.',
  '',
  '마지막에 아래 스키마의 JSON 코드블록을 **정확히 하나** 출력하라 (설명은 그 앞에):',
  '```json',
  '{"rq":"...","phase":"...","why":"...","next":["...","...","..."],"blockers":["..."],"acceptance":["..."]}',
  '```',
].join('\n');

const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(python harness/phase.py show:*)',
  'Bash(python harness/phase.py why:*)',
  'Bash(python harness/phase.py resume:*)',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
];

// ── 워크트리 준비 ───────────────────────────────────────────────────────────
/**
 * cold 의 정의가 이 시험의 전부다.
 *   cold = SessionStart 다이제스트 없음 **+ 라이브 커서 없음**.
 *          phase.json·session.json·.key 는 gitignore 대상이라 신선한 워크트리에
 *          애초에 없다. 즉 남는 것은 **커밋된 체크포인트뿐**이고, 그것만으로
 *          복원되는지가 계약의 실체다.
 *   warm = 다이제스트 + 라이브 커서 복사. 같은 머신에서 이어서 여는 상황.
 */
function prepareWorktree(wt) {
  const notes = [];
  const settingsPath = join(wt, '.claude/settings.json');
  if (COLD) {
    if (existsSync(settingsPath)) {
      let s = {};
      try {
        s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch {
        notes.push('워크트리의 .claude/settings.json 파싱 실패 — 통째로 비운다');
      }
      delete s.hooks;
      s._resume_test = 'cold 모드: hooks 제거됨. SessionStart 다이제스트가 뜨지 않는다.';
      writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
      notes.push('cold: settings.json 의 hooks 제거 → SessionStart 다이제스트 미발화');
    } else {
      notes.push('cold: 워크트리에 .claude/settings.json 이 없다 (원래 다이제스트가 없는 상태)');
    }
    notes.push('cold: 라이브 커서(phase.json·session.json·.key) 없음 — 커밋된 체크포인트만 남는다');
  } else {
    mkdirSync(join(wt, '.harness/state'), { recursive: true });
    let copied = 0;
    for (const f of ['phase.json', 'session.json', '.key']) {
      const src = join(ROOT, '.harness/state', f);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(wt, '.harness/state', f));
      copied++;
    }
    notes.push(`warm: 다이제스트 유지 + 라이브 커서 ${copied}건 복사`);
    if (copied === 0) notes.push('warm: 복사할 라이브 커서가 없었다 — 실질적으로 cold 와 같은 조건이다');
  }
  return notes;
}

// ── 판정 ────────────────────────────────────────────────────────────────────
function grade(ck, ans) {
  const s = ck.data.session || {};
  const rows = [];

  const rqOk = norm(ans?.rq).includes(norm(ck.data.rq));
  const phaseOk = norm(ans?.phase).includes(norm(ck.data.to));
  rows.push({
    q: 1,
    label: 'RQ · 단계',
    kind: 'auto',
    ok: rqOk && phaseOk,
    expected: `${ck.data.rq} / ${ck.data.to}`,
    got: `${ans?.rq ?? '(없음)'} / ${ans?.phase ?? '(없음)'}`,
    detail: `rq=${rqOk ? 'OK' : 'X'} phase=${phaseOk ? 'OK' : 'X'}`,
  });

  rows.push({
    q: 2,
    label: '왜 (goal)',
    kind: 'judge',
    ok: null,
    expected: s.goal || '(체크포인트에 goal 없음)',
    got: ans?.why ?? '(없음)',
    detail: 'evaluator 에이전트가 판정한다',
  });

  const nx = matchList(s.next, ans?.next, true);
  rows.push({ q: 3, label: '다음 행동 3개', kind: 'auto', ok: nx.ok, expected: s.next, got: ans?.next, detail: `${nx.hit}/${nx.total} 일치`, items: nx.items });

  const blockers = s.open_questions || [];
  const bl = matchList(blockers, ans?.blockers, false);
  const blOk = blockers.length === 0 ? isEmptyish(ans?.blockers) : bl.ok;
  rows.push({
    q: 4,
    label: '막고 있는 것',
    kind: 'auto',
    ok: blOk,
    expected: blockers.length ? blockers : '(열린 질문 없음 — "없다"가 정답)',
    got: ans?.blockers,
    detail: blockers.length ? `${bl.hit}/${bl.total} 일치` : blOk ? '없음을 없다고 답함' : '없는 블로커를 지어냈다',
    items: bl.items,
  });

  const ac = matchList(s.acceptance, ans?.acceptance, false);
  rows.push({ q: 5, label: '완료 판정 기준', kind: 'auto', ok: ac.ok, expected: s.acceptance, got: ans?.acceptance, detail: `${ac.hit}/${ac.total} 일치 (60% 이상 필요)`, items: ac.items });

  return rows;
}
function isEmptyish(v) {
  if (v == null) return true;
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length === 0) return true;
  return arr.every((x) => /^(없|없다|없음|해당 ?없음|none|n\/a|-)$/i.test(norm(x)));
}

// ── evaluator 판정 (추론 rubric 1건) ────────────────────────────────────────
/**
 * 정답지(goal)와 답안만 준다. 저장소 맥락은 주지 않는다 —
 * 판정자가 구현을 읽는 순간 "답이 그럴듯한가"가 아니라 "내가 아는 것과 같은가"를
 * 재게 되고, 그건 채점이 아니라 자기 확인이다.
 */
function judgeWhy(goal, why) {
  const sys = existsSync(EVALUATOR_AGENT) ? readFileSync(EVALUATOR_AGENT, 'utf8').replace(/^---[\s\S]*?---\n/, '') : '';
  const prompt = [
    '아래는 "왜 이 작업을 하는가"에 대한 정답지와, 대화 기록 없이 상태 파일만 읽고 복원한 답안이다.',
    '**정답지 외의 어떤 맥락도 주어지지 않는다.** 아래 두 텍스트만으로 판정하라.',
    '',
    '## 정답지 (체크포인트의 goal 필드)',
    goal || '(정답지 없음)',
    '',
    '## 답안',
    why || '(답안 없음)',
    '',
    '## 판정 기준',
    '- PASS: 답안이 정답지의 **동기(왜)** 를 담고 있다. 표현이 달라도 된다.',
    '- FAIL: 답안이 "무엇을 했는가"(작업 목록·산출물 나열)로 대체됐거나, 정답지의 동기와 어긋난다.',
    '  goal 을 done 으로 바꿔 답하는 것이 이 계약이 막으려는 실패다 — 무엇을 했는지는 git이 이미 안다.',
    '',
    '출력은 JSON 코드블록 하나만:',
    '```json',
    '{"verdict":"PASS","reason":"한 문장"}',
    '```',
  ].join('\n');

  const box = mkdtempSync(join(tmpdir(), 'resume-judge-'));
  try {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--disallowed-tools', 'Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'Task', 'WebSearch', 'WebFetch'];
    if (sys.trim()) args.push('--append-system-prompt', sys.trim());
    const r = spawnSync('claude', args, { cwd: box, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    if (r.error || r.status !== 0) {
      return { verdict: null, reason: `judge 실행 실패: ${r.error?.message || `exit ${r.status}`} ${(r.stderr || '').slice(0, 200)}` };
    }
    const j = extractJson(lastAssistantText(parseStream(r.stdout)));
    if (!j || !j.verdict) return { verdict: null, reason: 'judge 응답에서 JSON 판정을 찾지 못했다' };
    return { verdict: String(j.verdict).toUpperCase().includes('PASS') ? 'PASS' : 'FAIL', reason: String(j.reason || '') };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

// ── 본체 ────────────────────────────────────────────────────────────────────
function emit(payload, code) {
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

const cks = listCheckpoints();
if (cks.length === 0) {
  say('체크포인트가 없다 — 재개 시험을 칠 대상이 없다.');
  say('고치는 법: `python harness/phase.py enter <단계>` 로 전이를 한 번이라도 밟아라.');
  say('  전이할 때마다 .harness/state/checkpoints/<RQ>/<ISO>.json 이 자동으로 남고, 그 파일이 이 시험의 정답지다.');
  emit({ script: 'resume-test', status: 'unprepared', reason: 'no_checkpoint' }, EXIT_UNPREPARED);
}

const ck = AT ? cks.find((c) => c.name.startsWith(AT) || c.ts === AT) : cks[cks.length - 1];
if (!ck) {
  say(`--at ${AT} 에 해당하는 체크포인트가 없다.`);
  say(`고치는 법: 아래 중 하나를 골라라 (최근 5건):`);
  for (const c of cks.slice(-5)) say(`  ${c.rq}/${c.name}  ts=${c.ts}`);
  emit({ script: 'resume-test', status: 'unprepared', reason: 'checkpoint_not_found', at: AT }, EXIT_UNPREPARED);
}

say('재개 시험 (L3 졸업 시험 · GB-06) — 정답지는 체크포인트 파일 자체다');
say('');
say(`  모드      : ${COLD ? 'cold — 다이제스트 없음 · 라이브 커서 없음 (L3 계약)' : 'warm — 다이제스트 + 라이브 커서 (진단)'}`);
say(`  정답지    : ${ck.rel}`);
say(`  RQ · 단계 : ${ck.data.rq} · ${ck.data.to}   (전이 ${ck.data.from} → ${ck.data.to}, ${ck.ts})`);
say(`  PASS 기준 : ${BAR.minScore}/5 · 읽은 파일 ≤${BAR.maxFiles} · ${BAR.maxMinutes == null ? '시간 기준 없음' : `≤${BAR.maxMinutes}분`}`);
if (!COLD) {
  say('              warm 은 계약이 아니라 진단이다 — T.04 를 재는 것은 cold 하나뿐이고');
  say('              시간 병목은 상태 복원이 아니라 CLI 기동+모델 지연이라 판정 대상이 아니다.');
}
say('');

// 워크트리를 만들 sha 선택.
// 체크포인트가 기록한 head_sha 를 1순위로 쓴다. 다만 **체크포인트 파일 자체가 그
// 시점에는 아직 커밋되지 않았을 수 있다** — 그러면 시험지가 없는 시험장이 된다.
// 그래서 실재를 확인하고, 없으면 그 파일을 도입한 커밋으로 물러선다.
const ckSha = ck.data.head_sha || '';
const introduced = git(['log', '-1', '--format=%H', '--', ck.rel]).out;
let targetSha = '';
let shaNote = '';
if (ckSha && git(['cat-file', '-e', `${ckSha}^{commit}`]).ok && git(['cat-file', '-e', `${ckSha}:${ck.rel}`]).ok) {
  targetSha = ckSha;
  shaNote = '체크포인트가 기록한 head_sha';
} else if (introduced) {
  targetSha = introduced;
  shaNote = `체크포인트를 도입한 커밋 (기록된 head_sha ${ckSha.slice(0, 8) || '(없음)'} 에는 이 파일이 아직 없었다)`;
} else {
  say('이 체크포인트가 커밋되지 않았다 — 신선한 워크트리에서 재개할 수 없다.');
  say('고치는 법: `git commit -- .harness/state/checkpoints` 로 체크포인트를 커밋하라.');
  say('  체크포인트를 커밋하지 않으면 다른 머신·다른 클론에서 재개가 불가능해 T.04 상태 계약 자체가 성립하지 않는다.');
  emit({ script: 'resume-test', status: 'unprepared', reason: 'checkpoint_uncommitted', checkpoint: ck.rel }, EXIT_UNPREPARED);
}
say(`  워크트리  : ${targetSha.slice(0, 8)} — ${shaNote}`);

if (!DRY_RUN) {
  const cli = claudeOnPath();
  if (!cli.ok) {
    say('');
    say(`claude CLI 를 실행할 수 없다: ${cli.why}`);
    say('고치는 법: claude CLI 를 설치·인증하고 PATH 에 올려라 (`claude --version` 이 되어야 한다).');
    say('  이 스크립트는 이 상태를 FAIL 로 보고하지 않는다 — 상태 계약이 얇은 것과 시험을 못 친 것은 다른 사실이다.');
    emit({ script: 'resume-test', status: 'unavailable', reason: 'claude_cli', detail: cli.why }, EXIT_UNAVAILABLE);
  }
  say(`  claude    : ${cli.version}`);
}

if (DRY_RUN) {
  say('');
  say('── --dry-run: 정답지 내용 (LLM 을 돌리지 않는다) ──────────────────────');
  const s = ck.data.session || {};
  say(`  Q1 rq/phase : ${ck.data.rq} / ${ck.data.to}`);
  say(`  Q2 why      : ${(s.goal || '(없음)').slice(0, 100)}…`);
  say(`  Q3 next     : ${(s.next || []).length}건`);
  say(`  Q4 blockers : ${(s.open_questions || []).length}건`);
  say(`  Q5 accept   : ${(s.acceptance || []).length}건`);
  say('');
  say('── 고정 5문항 프롬프트 (이 텍스트가 시험지 전문이다) ─────────────────');
  for (const line of PROMPT.split('\n')) say(`  ${line}`);
  say('');
  say('  실제 시험: node scripts/resume-test.mjs --cold');
  emit({ script: 'resume-test', status: 'dry_run', checkpoint: ck.rel, sha: targetSha }, EXIT_PASS);
}

// ── 워크트리 생성 → 실행 → **무조건 정리** ──────────────────────────────────
const parent = mkdtempSync(join(tmpdir(), 'resume-test-'));
const wt = join(parent, 'wt');
let cleanupDone = false;
function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (KEEP) {
    say(`  워크트리 보존: ${wt}   (정리: git worktree remove --force "${wt}")`);
    return;
  }
  const rm = git(['worktree', 'remove', '--force', wt]);
  if (!rm.ok) rmSync(parent, { recursive: true, force: true });
  else rmSync(parent, { recursive: true, force: true });
  git(['worktree', 'prune']);
}
// 워크트리 누수는 개발 머신에서 실제로 성가시다. 예외·시그널 어느 쪽으로 끝나도 지운다.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup();
    process.exit(EXIT_UNPREPARED);
  });
}

let result;
try {
  const add = git(['worktree', 'add', '--detach', wt, targetSha]);
  if (!add.ok) {
    say('');
    say(`git worktree add 실패: ${add.err.slice(0, 300)}`);
    say('고치는 법: `git worktree list` 로 잔여 워크트리를 확인하고 `git worktree prune` 후 다시 실행하라.');
    emit({ script: 'resume-test', status: 'unprepared', reason: 'worktree_add', detail: add.err.slice(0, 300) }, EXIT_UNPREPARED);
  }

  const notes = prepareWorktree(wt);
  for (const n of notes) say(`  준비      : ${n}`);
  if (!existsSync(join(wt, ck.rel))) {
    say('');
    say(`워크트리에 정답지가 없다: ${ck.rel}`);
    say('고치는 법: 체크포인트를 커밋하라. 커밋되지 않은 체크포인트는 재개 계약의 대상이 아니다.');
    emit({ script: 'resume-test', status: 'unprepared', reason: 'answer_key_absent', checkpoint: ck.rel }, EXIT_UNPREPARED);
  }
  say('');

  const args = ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--max-turns', '30', '--allowedTools', ...ALLOWED_TOOLS];
  const hardTimeout = Math.max((BAR.maxMinutes ?? 5) * 2, 10) * 60 * 1000;
  say(`  실행      : claude -p (5문항) · 하드 타임아웃 ${Math.round(hardTimeout / 60000)}분`);
  const t0 = Date.now();
  const run = spawnSync('claude', args, { cwd: wt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: hardTimeout });
  const elapsedMs = Date.now() - t0;
  const minutes = elapsedMs / 60000;

  if (run.error && run.error.code === 'ETIMEDOUT') {
    say('');
    say(`시간 초과 — ${Math.round(hardTimeout / 60000)}분 안에 끝나지 않았다${BAR.maxMinutes == null ? ' (하드 타임아웃)' : `. 기준은 ${BAR.maxMinutes}분이다`}.`);
    say('고치는 법: 상태 파일이 답을 담고 있는지 먼저 보라. 오래 걸린다는 것은 대개 저장소를 뒤지고 있다는 뜻이다.');
    emit({ script: 'resume-test', mode: COLD ? 'cold' : 'warm', status: 'fail', reason: 'timeout', elapsed_minutes: Number(minutes.toFixed(2)) }, EXIT_FAIL);
  }

  const events = parseStream(run.stdout);
  const resultEv = events.find((e) => e.type === 'result');
  const stderrTail = (run.stderr || '').trim().slice(-500);
  if (run.status !== 0 || !resultEv || resultEv.is_error) {
    const detail = `${resultEv?.result || ''} ${stderrTail}`.trim();
    if (AUTH_HINT.test(detail) || (!resultEv && run.status !== 0)) {
      say('');
      say('claude -p 가 응답을 내지 못했다 (인증·한도·네트워크로 보인다).');
      say(`  관측: exit=${run.status} ${detail.slice(0, 300)}`);
      say('고치는 법: `claude` 를 대화형으로 한 번 띄워 로그인 상태를 확인하고 다시 실행하라.');
      say('  이것은 FAIL 이 아니다 — 시험을 못 친 것이지 상태 계약이 얇다는 증거가 아니다.');
      emit({ script: 'resume-test', mode: COLD ? 'cold' : 'warm', status: 'unavailable', reason: 'claude_run', detail: detail.slice(0, 300) }, EXIT_UNAVAILABLE);
    }
  }

  const text = lastAssistantText(events);
  const ans = extractJson(text);
  const tools = collectTools(events);

  if (VERBOSE) {
    say('── 답안 원문 ─────────────────────────────────────────────────────────');
    say(text.slice(0, 4000));
    say('');
  }

  if (!ans) {
    say('답안에서 JSON 블록을 찾지 못했다 — 채점할 수 없다.');
    say('고치는 법: --verbose 로 원문을 보라. 프롬프트가 요구한 JSON 스키마를 따르지 않았다면 그 자체가 실패다.');
    result = { rows: [], score: 0, ans: null };
  } else {
    result = { rows: grade(ck, ans), ans };
  }

  // ── 추론 rubric 1건 (왜) ──
  const whyRow = result.rows.find((r) => r.q === 2);
  if (whyRow) {
    const verdict = ans ? judgeWhy((ck.data.session || {}).goal, ans.why) : { verdict: 'FAIL', reason: '답안 없음' };
    whyRow.ok = verdict.verdict === 'PASS' ? true : verdict.verdict === 'FAIL' ? false : null;
    whyRow.detail = `evaluator: ${verdict.verdict ?? '판정 불가'} — ${verdict.reason}`;
    result.judge = verdict;
  }

  const score = result.rows.filter((r) => r.ok === true).length;
  const inconclusive = result.rows.some((r) => r.ok === null);

  // ── 출력 ──
  say('── 채점 ──────────────────────────────────────────────────────────────');
  for (const r of result.rows) {
    const mark = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : '????';
    say(`  ${mark}  Q${r.q} ${r.label.padEnd(14)} [${r.kind}]  ${r.detail}`);
    if (r.ok !== true) {
      say(`        기대: ${fmt(r.expected)}`);
      say(`        답안: ${fmt(r.got)}`);
      for (const it of r.items || []) {
        if (it.ok) continue;
        say(`          미일치: "${it.expected.slice(0, 80)}"  (앵커 ${it.hits}/${it.total} · dice ${it.dice.toFixed(2)})`);
      }
    }
  }
  say('');
  say('── 계측 ──────────────────────────────────────────────────────────────');
  say(`  읽은 파일 ${tools.files.length}개 / 예산 ${BAR.maxFiles}`);
  for (const f of tools.files) say(`    · ${f}`);
  if (tools.searches.length) say(`  검색 ${tools.searches.length}건 (읽기로 세지 않는다): ${tools.searches.slice(0, 6).join(' ')}`);
  say(`  소요 ${minutes.toFixed(2)}분${BAR.maxMinutes == null ? '  (계측만 — warm 은 시간으로 판정하지 않는다)' : ` / 기준 ${BAR.maxMinutes}분`}`);
  if (resultEv?.total_cost_usd != null) say(`  비용 $${Number(resultEv.total_cost_usd).toFixed(4)} · 턴 ${resultEv.num_turns ?? '?'}`);
  say('');

  const filesOk = tools.files.length <= BAR.maxFiles;
  const timeOk = BAR.maxMinutes == null || minutes <= BAR.maxMinutes;
  const scoreOk = score >= BAR.minScore;
  const pass = scoreOk && filesOk && timeOk && !inconclusive;

  const payload = {
    script: 'resume-test',
    mode: COLD ? 'cold' : 'warm',
    status: pass ? 'pass' : inconclusive ? 'inconclusive' : 'fail',
    checkpoint: ck.rel,
    checkpoint_ts: ck.ts,
    worktree_sha: targetSha,
    score,
    max_score: 5,
    files_read: tools.files.length,
    files: tools.files,
    elapsed_minutes: Number(minutes.toFixed(2)),
    bar: BAR,
    rows: result.rows.map((r) => ({ q: r.q, label: r.label, kind: r.kind, ok: r.ok, detail: r.detail })),
    judge: result.judge || null,
    cost_usd: resultEv?.total_cost_usd ?? null,
  };

  if (pass) {
    say(`요약: PASS — ${score}/5 · 읽은 파일 ${tools.files.length}/${BAR.maxFiles} · ${minutes.toFixed(2)}분${BAR.maxMinutes == null ? '(미판정)' : `/${BAR.maxMinutes}분`}`);
    if (COLD) say('cold 통과 = 커밋된 체크포인트만으로 새 세션이 복원됐다. T.04 상태 계약이 실증됐다.');
    emit(payload, EXIT_PASS);
  }
  if (inconclusive) {
    say(`요약: 판정 불가 — 추론 rubric 을 채점하지 못했다 (결정론 ${score}/4).`);
    say('고치는 법: judge 실행 실패 사유를 보라. 판정 못 한 것을 통과로 적으면 이 시험의 의미가 사라진다.');
    emit(payload, EXIT_UNAVAILABLE);
  }
  say(`요약: FAIL — ${score}/5 · 읽은 파일 ${tools.files.length}/${BAR.maxFiles} · ${minutes.toFixed(2)}분${BAR.maxMinutes == null ? '(미판정)' : `/${BAR.maxMinutes}분`}`);
  if (!scoreOk) say('  · 문항 미달 — 체크포인트가 담지 못한 항목이 무엇인지 위 "기대/답안"을 보라.');
  if (!filesOk) say(`  · 파일 예산 초과 — 저장소를 뒤져서 맞혔다는 뜻이다. 맞혀도 계약 이행이 아니다.`);
  if (!timeOk) say('  · 시간 초과 — 상태 파일이 답을 바로 주지 못했다.');
  say('고치는 법: `python harness/phase.py session --goal … --next … --acceptance …` 로 세션 선언을 채우고');
  say('  전이를 한 번 밟아 새 체크포인트를 만든 뒤 다시 시험하라. 체크포인트가 정답지이므로,');
  say('  체크포인트에 없는 것은 어떤 에이전트도 복원할 수 없다 — 그것이 이 시험이 재는 것이다.');
  emit(payload, EXIT_FAIL);
} finally {
  cleanup();
}

function fmt(v) {
  if (v == null) return '(없음)';
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 70)).join(' | ') || '(빈 배열)';
  return String(v).slice(0, 200);
}
