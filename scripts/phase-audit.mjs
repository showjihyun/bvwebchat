#!/usr/bin/env node
/**
 * scripts/phase-audit.mjs — git 이력만으로 단계 순서를 **독립 재유도**하고 phase.jsonl과 대조한다.
 *
 * ## 이것은 예방이 아니라 탐지다.
 *
 * `gate_phase.py`는 Write/Edit 도구와 Bash 리다이렉트만 본다. `node -e "fs.writeFileSync('src/x.ts', …)"`
 * 는 그대로 통과한다. 문자열 파싱으로 막을 수 있다고 주장하는 순간 그 주장이 거짓말이 된다 —
 * 셸을 통째로 봉쇄하지 않는 한 경계면에는 구멍이 있고, 봉쇄하지 않는 것은 의도된 선택이다.
 *
 * 그래서 방어를 한 층 더 둔다: **git 이력은 도구를 우회해도 남는다.** 어떤 커밋이 tests/를
 * 건드렸고 어떤 커밋이 src/를 건드렸는지, 그 순서가 어땠는지는 훅과 무관하게 기록된다.
 * 이 스크립트는 그 순서에서 "있었어야 할 단계"를 재유도해 실제 기록과 대조한다.
 *
 * **막지 못한다. 다만 숨길 수 없게 만든다.**
 *
 *   node scripts/phase-audit.mjs                기본 (기록과의 모순만 차단)
 *   node scripts/phase-audit.mjs --strict       이력 자체의 이상(단계 혼합 커밋 등)도 차단
 *   node scripts/phase-audit.mjs --base <ref>   비교 기준 (기본 origin/main → main → 전체 이력)
 *   node scripts/phase-audit.mjs --all          브랜치가 아니라 저장소 전체 이력을 감사
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PHASE_LOG = join(ROOT, '.harness/state/phase.jsonl');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/phase-audit.mjs [--base <ref>] [--all] [--strict]');
  process.exit(0);
}
const STRICT = argv.includes('--strict');
const ALL = argv.includes('--all');
const BASE = (() => {
  const i = argv.indexOf('--base');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// ── 감사 범위 ───────────────────────────────────────────────────────────────
let range = null;
let rangeLabel = '저장소 전체 이력';
if (!ALL) {
  for (const ref of [BASE, 'origin/main', 'main'].filter(Boolean)) {
    if (git(['rev-parse', '--verify', '--quiet', ref]) !== null) {
      const mb = (git(['merge-base', ref, 'HEAD']) || '').trim();
      if (mb) {
        range = `${mb}..HEAD`;
        rangeLabel = `${ref}...HEAD`;
        break;
      }
    }
  }
}

const MARK = '@@c@@';
function loadCommits() {
  const args = ['log', '--reverse', `--pretty=format:${MARK}%H %cI %an%x09%s`, '--name-only'];
  if (range) args.push(range);
  const out = git(args);
  if (out === null) return null;
  const list = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(MARK)) {
      const rest = line.slice(MARK.length);
      const a = rest.indexOf(' ');
      const b = rest.indexOf(' ', a + 1);
      const tab = rest.indexOf('\t');
      cur = {
        sha: rest.slice(0, a),
        time: rest.slice(a + 1, b),
        author: rest.slice(b + 1, tab < 0 ? b + 1 : tab),
        subject: tab < 0 ? rest.slice(b + 1) : rest.slice(tab + 1),
        files: [],
      };
      list.push(cur);
      continue;
    }
    if (cur) cur.files.push(line);
  }
  return list;
}

const commits = loadCommits();
if (commits === null) {
  console.error('git 이력을 읽을 수 없다 — 이 저장소가 git 저장소가 아니거나 git이 PATH에 없다.');
  console.error('고치는 법: 저장소 루트에서 실행하라. 이 감사는 git 이력을 유일한 독립 증거로 쓴다.');
  process.exit(1);
}

// ── 커밋 → 함의된 단계 ──────────────────────────────────────────────────────
const CLASS = [
  ['tests', /^tests\//],
  ['src', /^src\//],
  ['specs', /^(specs\/|docs\/adr\/)/],
  ['harness', /^(\.claude\/|harness\/|scripts\/|\.github\/|docs\/harness\/|evals\/)/],
  ['docs', /^(docs\/|README\.md|CLAUDE\.md)/],
];
function classify(files) {
  const kinds = new Set();
  for (const f of files) {
    for (const [name, re] of CLASS) {
      if (re.test(f)) {
        kinds.add(name);
        break;
      }
    }
  }
  return kinds;
}
/** 이 커밋을 만들 수 있었던 단계들. 여러 개면 판정하지 않는다 — 억측은 감사가 아니다. */
function impliedPhases(kinds) {
  const out = new Set();
  if (kinds.has('tests')) out.add('RED');
  if (kinds.has('src')) out.add('GREEN');
  if (kinds.has('specs')) out.add('SPEC');
  if (kinds.has('harness')) out.add('HARNESS');
  return out;
}

for (const c of commits) {
  c.kinds = classify(c.files);
  c.implied = impliedPhases(c.kinds);
}

// ── RQ 그룹 ─────────────────────────────────────────────────────────────────
function rqOf(c) {
  const fromSubject = /\b(RQ-\d+)/i.exec(c.subject);
  if (fromSubject) return fromSubject[1].toUpperCase();
  for (const f of c.files) {
    const m = /(?:^|\/)rq-(\d+)/i.exec(f);
    if (m) return `RQ-${m[1]}`;
  }
  return null;
}
const byRq = new Map();
for (const c of commits) {
  const rq = rqOf(c);
  if (!rq) continue;
  if (!byRq.has(rq)) byRq.set(rq, []);
  byRq.get(rq).push(c);
}

// ── 기록된 전이 ─────────────────────────────────────────────────────────────
const recorded = existsSync(PHASE_LOG)
  ? readFileSync(PHASE_LOG, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : null;

const contradictions = []; // 기록과 이력이 모순 — 차단
const anomalies = []; // 이력 자체의 이상 — 기본 advisory
function contra(group, what, how) {
  contradictions.push({ group, what, how });
}
function anomaly(what, how) {
  anomalies.push({ what, how });
}

// ── A1: 한 커밋이 여러 단계를 섞는다 ────────────────────────────────────────
for (const c of commits) {
  if (c.kinds.has('tests') && c.kinds.has('src')) {
    anomaly(
      `${c.sha.slice(0, 7)} 한 커밋이 tests/와 src/를 함께 바꿨다 — RED와 GREEN이 한 커밋에 있다`,
      `커밋을 나눠라: 실패하는 테스트를 먼저 커밋(RED)하고, 통과시키는 구현을 따로 커밋(GREEN)한다. ` +
        `합쳐 두면 "테스트가 먼저였는가"를 사후에 증명할 방법이 사라진다 — M3가 측정할 대상 자체가 없어진다.`
    );
  }
  if (c.kinds.has('src') && c.kinds.has('harness') && !c.kinds.has('tests')) {
    anomaly(
      `${c.sha.slice(0, 7)} 한 커밋이 src/와 하네스를 함께 바꿨다`,
      `CLAUDE.md의 "하네스 전용 PR" 카브아웃이 뭉개진다. 하네스 변경은 별도 커밋·별도 PR로 분리하라 — ` +
        `섞이면 그 PR의 증거 사슬이 오염된다.`
    );
  }
}

// ── A2: RQ별 테스트 선행 순서 ───────────────────────────────────────────────
const rqOrder = [];
for (const [rq, list] of byRq) {
  const firstTest = list.find((c) => c.kinds.has('tests'));
  const firstSrc = list.find((c) => c.kinds.has('src'));
  let verdict;
  if (!firstTest && !firstSrc) verdict = '해당 없음';
  else if (!firstTest) verdict = '테스트 없음';
  else if (!firstSrc) verdict = '구현 없음';
  else if (firstTest === firstSrc) verdict = '동일 커밋';
  else verdict = Date.parse(firstTest.time) <= Date.parse(firstSrc.time) ? '테스트 선행' : '구현 선행';
  rqOrder.push({ rq, verdict, firstTest, firstSrc, n: list.length });
  if (verdict === '구현 선행') {
    anomaly(
      `${rq} — 구현(${firstSrc.sha.slice(0, 7)})이 테스트(${firstTest.sha.slice(0, 7)})보다 먼저다`,
      `git 이력이 RED→GREEN 순서와 반대다. 사후에 고칠 수는 없고, 기록으로 남긴다. ` +
        `다음 RQ에서는 tests/ 커밋을 먼저 만들어라 — RED→GREEN 전이 가드(tests_committed)가 이것을 앞에서 막는다.`
    );
  }
  if (verdict === '테스트 없음') {
    anomaly(
      `${rq} — src/ 변경은 있는데 tests/ 커밋이 하나도 없다`,
      `골든 커버리지(node scripts/golden-coverage.mjs --rq ${rq})로 이 RQ의 GA 케이스가 실제로 검증되는지 확인하라.`
    );
  }
}

// ── A3: 기록 대조 — 여기서만 차단한다 ───────────────────────────────────────
let auditable = 0;
if (recorded === null) {
  anomaly(
    '.harness/state/phase.jsonl이 없다 — 대조할 기록이 없다',
    'python harness/phase.py enter <PHASE> 로 단계를 기록하기 시작하라. 기록이 없으면 이 감사는 이력의 절반만 본다(재유도만 가능, 대조 불가).'
  );
} else if (recorded.length === 0) {
  anomaly('phase.jsonl이 비어 있다 — 전이 기록 0건', '아직 아무 단계도 선언되지 않았다. 대조 불가.');
} else {
  // 기록된 전이의 head_sha 시점에서, 그 단계가 허용하지 않는 파일이 그 뒤에 커밋됐는가
  const matrixPath = join(ROOT, 'harness/policy/phase-matrix.json');
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  } catch {
    matrix = null;
  }

  const shaIndex = new Map(commits.map((c, i) => [c.sha, i]));
  const sorted = [...recorded].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const from = Date.parse(cur.ts);
    const to = next ? Date.parse(next.ts) : Infinity;
    const during = commits.filter((c) => {
      const t = Date.parse(c.time);
      return t >= from && t < to;
    });
    if (!during.length) continue;
    auditable++;

    const pd = matrix?.phases?.[cur.to];
    if (!pd) continue;
    for (const c of during) {
      const implied = [...c.implied];
      // 이 단계에서 만들 수 없었어야 할 종류의 커밋이 이 단계 구간에 있다
      const forbidden = implied.filter((ph) => {
        if (ph === 'RED') return !pd.write_allow.some((p) => p.startsWith('tests/'));
        if (ph === 'GREEN') return !pd.write_allow.some((p) => p.startsWith('src/'));
        if (ph === 'SPEC') return !pd.write_allow.some((p) => p.startsWith('specs/') || p.startsWith('docs/adr'));
        return false;
      });
      if (forbidden.length) {
        // 이 단계가 warn_only면 게이트는 **경고만 하고 통과시킨 것**이다. "우회당했다"와
        // "설계대로 유예했다"는 전혀 다른 사건이므로 메시지가 그것을 섞으면 안 된다.
        const lenient = (matrix?.enforce?.warn_only || []).includes(cur.to);
        contra(
          `${cur.to} 단계에 ${forbidden.join('/')} 커밋`,
          `${c.sha.slice(0, 7)} "${c.subject.slice(0, 56)}"`,
          lenient
            ? `${cur.to}의 write_allow는 [${pd.write_allow.join(' ')}]이고 ${forbidden.join('/')}의 경로는 거기 없다. ` +
                `다만 이 단계는 enforce.warn_only에 있어 게이트가 **경고만 하고 통과시켰다** — 우회당한 것이 아니라 설계대로 유예한 것이다. ` +
                `선택지 둘: (1) 이 작업이 정당했다면 단계 배치가 틀렸다 → 그 일을 맞는 단계로 옮기거나 write_allow를 넓혀라. ` +
                `(2) 정당하지 않았다면 유예가 문제다 → enforce.warn_only에서 "${cur.to}"를 빼면 다음부터 실제로 막힌다. ` +
                `둘 중 무엇인지는 로그가 모른다 — 커밋을 보고 사람이 정한다.`
            : `${cur.to}의 write_allow는 [${pd.write_allow.join(' ')}]다. 이 단계는 유예 대상이 아닌데도 커밋이 존재한다 — ` +
                `경로 셋 중 하나다: (1) 훅을 우회했다(node -e 등 — 이 감사가 존재하는 이유다), ` +
                `(2) 단계 선언 없이 작업하고 나중에 선언했다, (3) 커밋 시각과 전이 시각이 겹쳐 오분류됐다. ` +
                `(2)라면 다음부터 작업 **전에** python harness/phase.py enter 를 실행하라.`
        );
      }
    }
  }

  // 기록된 head_sha가 실제 이력에 없으면 기록 자체가 다른 세계를 가리킨다
  for (const r of recorded) {
    if (!r.head_sha || r.head_sha === '0'.repeat(40)) continue;
    if (!shaIndex.has(r.head_sha) && ALL) {
      anomaly(
        `phase.jsonl의 head_sha ${r.head_sha.slice(0, 7)} (${r.from}→${r.to})가 감사 범위의 이력에 없다`,
        '리베이스·강제 푸시로 이력이 재작성됐거나, 다른 브랜치의 기록이다. 상태 로그는 이력과 같은 세계를 가리켜야 한다.'
      );
    }
  }
}

// ── 출력 ────────────────────────────────────────────────────────────────────
console.log('단계 감사 — git 이력에서 단계 순서를 독립 재유도해 phase.jsonl과 대조한다');
console.log('');
console.log('  ┌─ 이것은 **탐지**이지 예방이 아니다. gate_phase.py는 Write/Edit/Bash 리다이렉트만 본다 —');
console.log("  │  node -e \"fs.writeFileSync('src/x.ts', …)\" 같은 우회는 훅이 막지 못한다.");
console.log('  └─ git 이력은 도구를 우회해도 남는다. 막지는 못하고, 숨길 수 없게 한다.');
console.log('');
console.log(`  감사 범위: ${rangeLabel} · 커밋 ${commits.length}개 · RQ 그룹 ${byRq.size}개`);
console.log(`  기록된 전이: ${recorded === null ? '(phase.jsonl 없음)' : `${recorded.length}건`}${recorded ? ` · 커밋과 겹치는 구간 ${auditable}개` : ''}`);
console.log('');

if (rqOrder.length) {
  console.log('── RQ별 함의된 순서 (git 이력만으로 재유도) ──────────────────────────');
  for (const r of rqOrder.sort((a, b) => a.rq.localeCompare(b.rq, 'en', { numeric: true }))) {
    const mark = r.verdict === '테스트 선행' ? 'OK  ' : r.verdict === '해당 없음' || r.verdict === '구현 없음' ? '—   ' : 'WARN';
    console.log(
      `  ${mark} ${r.rq.padEnd(6)} ${r.verdict.padEnd(8)} 커밋 ${String(r.n).padStart(2)}개` +
        (r.firstTest ? ` · 첫 테스트 ${r.firstTest.sha.slice(0, 7)}` : '') +
        (r.firstSrc ? ` · 첫 구현 ${r.firstSrc.sha.slice(0, 7)}` : '')
    );
  }
  console.log('');
  console.log('  주의: 이 표는 **M3가 아니다.** M3는 phase.jsonl의 unforced RED→GREEN 전이로만 잰다.');
  console.log('  git 순서는 재유도된 함의일 뿐이고, 둘을 같은 지표로 쓰면 서로 다른 답을 낸다.');
  console.log('');
}

if (contradictions.length) {
  console.log('── 기록과의 모순 (차단) ──────────────────────────────────────────────');
  const groups = new Map();
  for (const c of contradictions) {
    if (!groups.has(c.group)) groups.set(c.group, { how: c.how, items: [] });
    groups.get(c.group).items.push(c.what);
  }
  for (const [group, g] of groups) {
    console.log(`FAIL ${group} — ${g.items.length}건`);
    for (const it of g.items.slice(0, 6)) console.log(`       ${it}`);
    if (g.items.length > 6) console.log(`       … 외 ${g.items.length - 6}건`);
    console.log(`     고치는 법: ${g.how}`);
    console.log('');
  }
}
if (anomalies.length) {
  console.log(`── 이력 자체의 이상 (${STRICT ? '차단 — --strict' : 'advisory'}) ───────────────────────────`);
  for (const a of anomalies) {
    console.log(`${STRICT ? 'FAIL' : 'WARN'} ${a.what}`);
    console.log(`     고치는 법: ${a.how}`);
  }
  console.log('');
}

if (!contradictions.length && !anomalies.length) {
  console.log('  이상 없음 — 재유도된 순서와 기록이 어긋나지 않는다.');
  console.log('');
}

const blocking = contradictions.length + (STRICT ? anomalies.length : 0);
if (blocking) {
  console.log(`단계 감사 실패 — 모순 ${contradictions.length}건${STRICT ? ` · 이력 이상 ${anomalies.length}건` : ''}.`);
  console.log('기본 모드는 **기록과의 모순만** 차단한다. 게이트 도입 이전의 이력은 단계 기록이 없어');
  console.log('모순이 성립하지 않으므로, 옛 커밋 때문에 CI가 빨개지지 않는다 (--strict로 승격 가능).');
  process.exit(1);
}
console.log(`단계 감사 통과 — 모순 0건${anomalies.length ? ` (이력 이상 ${anomalies.length}건은 advisory)` : ''}.`);
process.exit(0);
