#!/usr/bin/env node
/**
 * scripts/doc-freshness.mjs — 문서 드리프트 센서 (C1~C7).
 *
 * 핵심 설계 결정: **문서에서 `updated:` 필드를 읽지 않는다.**
 * 프론트매터의 날짜는 반드시 거짓말을 한다 — 문서를 고치면서 날짜를 안 고치거나, 날짜만 고친다.
 * 갱신일은 전부 git에서 유도한다: `git log -1 --format=%cI -- <path>`.
 * 이 결정 하나가 "메타데이터 자체의 드리프트"라는 문제 계층을 통째로 제거한다.
 * 따라서 이 스크립트에는 날짜를 **쓰는** 경로가 없다. 읽기만 한다.
 *
 *   --digest              ≤5줄. SessionStart 훅용. 항상 exit 0 (세션을 막지 않는다)
 *   --pr [--base <ref>]   차단용. C2를 **이 PR이 건드린 파일로만** 좁힌다
 *   --full                저장소 전체 + 처방. harness-audit 스킬용 (기본 모드)
 *   --strict              advisory(C2 repo·C3·C6)도 차단 대상으로 승격
 *
 * 검사 정의와 심각도의 진실 공급원은 harness/doc-map.json이다. 이 파일은 그것을 실행할 뿐이다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, posix } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOC_MAP = join(ROOT, 'harness/doc-map.json');
const DAY = 86400000;

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/doc-freshness.mjs [--digest | --pr [--base <ref>] | --full] [--strict | --self-test]');
  console.log('  --self-test  C2 면제 판정 · C7 수치 판정 음성 시험 (git·LLM 불요)');
  process.exit(0);
}
const MODE = argv.includes('--digest') ? 'digest' : argv.includes('--pr') ? 'pr' : 'full';
const STRICT = argv.includes('--strict');
const BASE = (() => {
  const i = argv.indexOf('--base');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'origin/main';
})();

// ── git ─────────────────────────────────────────────────────────────────────
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * 전체 이력을 한 번만 읽어 경로 → 최신 커밋 시각 색인을 만든다.
 * `git log -1 -- <path>`를 문서마다 부르면 문서 24개 × 의존 10개 = 프로세스 240개다.
 * 결과는 `git log -1 --format=%cI -- <path>`와 동일하다 (git log는 최신순이므로 첫 등장이 최신 커밋).
 * 느린 센서는 꺼지는 센서다.
 */
const MARK = '@@commit@@';
function buildCommitIndex() {
  const out = git(['log', `--pretty=format:${MARK}%cI ${MARK}%h`, '--name-only']);
  const index = new Map();
  if (out === null) return index;
  let time = null;
  let sha = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(MARK)) {
      const [t, h] = line.split(` ${MARK}`);
      time = t.slice(MARK.length);
      sha = h;
      continue;
    }
    if (!index.has(line)) index.set(line, { time, sha });
  }
  return index;
}

function listFiles() {
  const out = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  if (out === null) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── glob ────────────────────────────────────────────────────────────────────
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const reCache = new Map();
function matches(glob, path) {
  if (!reCache.has(glob)) reCache.set(glob, globToRegExp(glob));
  return reCache.get(glob).test(path);
}

// ── 로드 ────────────────────────────────────────────────────────────────────
if (!existsSync(DOC_MAP)) {
  console.error('harness/doc-map.json이 없다 — 문서 레지스트리 없이는 이 센서가 판단할 근거가 없다.');
  console.error('고치는 법: harness/doc-map.json을 만들어라 (governed_globs / docs[] / checks).');
  process.exit(1);
}
let map;
try {
  map = JSON.parse(readFileSync(DOC_MAP, 'utf8'));
} catch (e) {
  console.error(`harness/doc-map.json 파싱 실패: ${e.message}`);
  console.error('고치는 법: JSON 문법 오류를 고쳐라. 이 파일이 깨지면 문서 거버넌스 전체가 멈춘다.');
  process.exit(1);
}

const CHECKS = map.checks || {};
const DEFAULTS = map.defaults || {};
const files = listFiles();
const commits = buildCommitIndex();
const NOW = Date.now();

const findings = []; // {check, severity, doc, lines[]}
function add(check, doc, lines) {
  const def = CHECKS[check] || {};
  let severity = def.severity || 'advisory';
  // C2는 PR 범위에서만 blocking — 저장소 전체 낡음을 게이트로 걸면 첫날부터 모든 PR이 빨개지고
  // 게이트는 그날로 무시된다. "이 PR이 건드린 의존만 책임진다"가 게이트를 살려둔다.
  if (check === 'C2' && MODE !== 'pr' && def.advisory_scope) severity = 'advisory';
  findings.push({ check, severity, doc, lines });
}

function lastCommit(path) {
  return commits.get(path) || null;
}
function expand(pattern) {
  if (!/[*?]/.test(pattern)) return existsSync(join(ROOT, pattern)) ? [pattern] : [];
  return files.filter((f) => matches(pattern, f));
}
function ageDays(iso) {
  return Math.floor((NOW - Date.parse(iso)) / DAY);
}
function fmt(iso) {
  return iso ? iso.replace('T', ' ').replace(/[+-]\d\d:\d\d$/, '') : '(미커밋)';
}

// ── PR 범위 ─────────────────────────────────────────────────────────────────
let changed = null;
let baseUsed = null;
if (MODE === 'pr') {
  for (const ref of [BASE, 'main', 'HEAD~1']) {
    const out = git(['diff', '--name-only', `${ref}...HEAD`]);
    if (out !== null) {
      changed = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
      baseUsed = ref;
      break;
    }
  }
  if (changed === null) {
    changed = new Set();
    baseUsed = '(base 참조 해석 실패 — 워킹트리만 봄)';
  }
  // 워킹트리·인덱스의 미커밋 변경도 이 PR의 일부로 본다 (커밋 전 로컬 실행에서도 맞는 답이 나오게)
  for (const args of [['diff', '--name-only', 'HEAD'], ['diff', '--name-only', '--cached']]) {
    for (const f of (git(args) || '').split('\n')) if (f.trim()) changed.add(f.trim());
  }
}

// ── C1 레지스트리 완결성 ────────────────────────────────────────────────────
// `exclude_globs` 를 뺐다 (2026-08-06 감사 F-2). governed_globs 는 **허용목록**이라
// 목록에 없는 경로는 애초에 이 모집단에 안 들어온다 — 제외 목록은 없는 것을 빼고 있었고
// 5개 항목 전부 교집합 0건이었다(실측). 죽은 설정이 판단의 흔적처럼 읽혀 실제로 오진을
// 낳았다: "claudedocs 는 exclude_globs 라 센서가 안 본다" — 결론은 맞고 원인은 틀렸다.
// 아무도 판단한 적이 없었던 것이다. 관리 대상에서 빼려면 governed_globs 에 넣지 않는다.
const governed = files.filter((f) => (map.governed_globs || []).some((g) => matches(g, f)));
const registryPatterns = (map.docs || []).map((d) => d.path);

function checkC1() {
  for (const f of governed.filter((f) => !registryPatterns.some((p) => p === f || matches(p, f)))) {
    add('C1', f, [
      `레지스트리에 없는 관리 대상 문서: ${f}`,
      `  고치는 법: harness/doc-map.json의 docs[]에 항목을 추가하라 —`,
      `    { "path": "${f}", "tier": ${DEFAULTS.tier ?? 2}, "purpose": "...", "depends_on": [], "review_every_days": ${DEFAULTS.review_every_days ?? 90} }`,
      `  이 문서가 관리 대상이 아니면 governed_globs에서 그 경로를 빼라 (허용목록이다).`,
      `  등록할 때는 어느 단계가 이 문서를 쓸 수 있는지 함께 정해라 — policy-lint P14가 관할 없는 등록을 거부한다.`,
    ]);
  }
  for (const d of map.docs || []) {
    if (expand(d.path).length === 0) {
      add('C1', d.path, [
        `레지스트리에 등록됐지만 실재하지 않는 문서: ${d.path}`,
        `  고치는 법: 파일을 만들거나(목적: ${d.purpose || '—'}), doc-map.json의 docs[]에서 이 항목을 지워라.`,
        `  존재하지 않는 문서의 depends_on은 영원히 검사되지 않는다 — 조용한 무검사가 가장 나쁘다.`,
      ]);
    }
  }
}

/**
 * C2 면제 판정 — **"검토했고 안 낡았다"를 근거와 함께 기록한 것만** 통과시킨다.
 *
 * C2 는 커밋 시각으로만 재므로 **문서가 그 의존을 가리키기만 할 때도** 발화한다.
 * 지금까지는 의존을 빼서(narrowing) 풀었고 그렇게 여섯 번 했다. 그런데 2026-08-04 에
 * 그 처방이 안 듣는 형상이 나왔다: `phase-matrix.json` 에 가드 필드 하나를 더하자
 * **그 매트릭스의 값을 실제로 재서술하는 문서 다섯이 동시에 발화**했다 —
 * `CLAUDE.md`(9단계 이름·가드 이름) · `coder.md`·`test-writer.md`(단계별 쓰기 규칙) ·
 * `checkpoint-resume`(`phase.py` 명령 출력 계약) · `policy/README.md`(생성물).
 * **다섯 다 의존이 옳고 다섯 다 안 낡았다** — 좁히면 진짜 드리프트 탐지를 지운다.
 * 그리고 손댈 내용이 없으니 `doc.time` 을 뒤로 보낼 수도 없다(무변경 터치는 금지).
 *
 * 즉 **검토 결과를 남길 자리가 없어서** 막히는 것이지 문서가 낡아서가 아니다.
 * 이 함수가 그 자리다. 억제가 아니라 **판단의 박제**이고, 두 가지로 그것을 보장한다:
 *
 *  1. `sha` 가 **현재 의존 커밋과 다르면 무시**한다 → 다음 변경에 자동 재무장된다.
 *     면제는 "이 변경까지 검토했다"는 뜻이지 "이 의존을 앞으로 안 본다"가 아니다.
 *  2. `sha` 나 `why` 가 **없거나 비면 무시**한다 → fail-closed.
 *     판정할 수 없는 면제는 없는 면제다(`recurrence.md` R2).
 */
export function judgeC2Ack(ack, depFile, depSha) {
  if (!ack || typeof ack !== 'object') return { exempt: false, why: '면제 기록 없음' };
  const entries = Array.isArray(ack) ? ack : [ack];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const sha = typeof e.sha === 'string' ? e.sha.trim() : '';
    const why = typeof e.why === 'string' ? e.why.trim() : '';
    if (!sha || !why) continue; // fail-closed — 근거 없는 면제는 면제가 아니다
    // 길이 하한 (2026-08-04 리뷰 M-1). 일치 판정이 접두 비교라 `sha:"e"` 는 다음 커밋
    // 16분의 1을, `"e8"` 은 256분의 1을 계속 면제한다. 이 설계의 안전성 주장 전체가
    // *"의존이 바뀌면 자동 재무장"* 하나에 걸려 있는데, 하한이 없으면 그 주장이
    // *"작성자가 충분히 긴 sha 를 적을 때만"* 으로 약해진다. 면제를 적는 주체와
    // 면제로 이득을 보는 주체가 같은 자리다 — fail-closed 로 막는다.
    if (sha.length < 7) continue;
    if (e.dep !== depFile) continue;
    if (!depSha || !(depSha.startsWith(sha) || sha.startsWith(depSha))) {
      return { exempt: false, why: `면제가 ${sha} 까지만 검토했는데 의존은 ${depSha || '(불명)'} 다 — 재검토가 필요하다` };
    }
    return { exempt: true, why };
  }
  return { exempt: false, why: '이 의존에 대한 면제 기록 없음' };
}

// ── C7 문서 수치 대조 — 순수 판정 ──────────────────────────────────────────
//
// **왜 이 검사가 있는가.** PR #46 의 리뷰가 **5회 연속** 문서 수치로 REQUEST_CHANGES 였다.
// 매 회차 사람이 대조 축을 하나씩 넓혔고(`N회` → `N행` → `N건` → 한글 수사 → 날짜 범위)
// **매번 그 바깥에서 하나가 나왔다.** 다음 축을 미리 알 수 없으므로 축을 넓히는 방식으로는
// 닫히지 않는다. 게다가 5차에서 나온 것 하나는 낡은 값이 아니라 **4차 조치 커밋이 새로 써
// 넣은 값**이었다 — 손으로 고치는 행위 자체가 새 인스턴스를 만든다.
//
// **값은 문서 한 곳에만 두고 정본은 코드가 갖는다**(대장 R10). 문서는 `data-verify="이름"` 으로
// 측정 이름만 선언하고, 여기 `MEASURES` 가 그 이름의 값을 스스로 잰다.
//
// **문서가 적은 셸 명령을 읽어 실행하지 않는다.** 그렇게 하면 문서가 임의 명령을 돌릴 수 있어
// `tool-risk.json` 의 등급 체계를 우회하는 통로가 된다. 측정은 **코드 안의 허용 목록**이고
// 모르는 이름은 조용히 통과가 아니라 **실패**다 — 오타 하나로 검사가 꺼지면 그건 센서가 아니다.

/** 문서 값의 정규화 — 태그·엔티티·천 단위 쉼표·공백을 걷어낸다. */
export function normalizeDocValue(raw) {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 대조 판정. **순수 함수다** — 파일을 읽지 않으므로 합성 케이스로 시험할 수 있다.
 *
 * @param annotations [{doc, line, name, value}]  문서에서 뽑은 선언
 * @param truth       {이름: 정본값}              MEASURES 의 실측 결과
 * @returns [{doc, line, name, kind, docValue, truthValue}]  빈 배열이면 통과
 */
export function judgeDocNumbers(annotations, truth) {
  const problems = [];
  const seen = new Map(); // `${doc}\0${name}` → 첫 값
  for (const a of annotations || []) {
    const name = String(a?.name ?? '').trim();
    const docValue = normalizeDocValue(a?.value);
    const at = { doc: a?.doc, line: a?.line, name, docValue };

    // 모르는 이름 → 실패. 조용한 통과는 "검사했다"와 "검사가 없다"를 구별 못 하게 만든다.
    if (!name || !Object.prototype.hasOwnProperty.call(truth || {}, name)) {
      problems.push({ ...at, kind: 'unknown', truthValue: null });
      continue;
    }
    // 정본을 잴 수 없는 상태(파일 부재 등)는 **통과가 아니다.** 신선한 체크아웃에서
    // 측정이 조용히 죽으면 이 검사는 CI 에서만 없는 검사가 된다 — R9 의 형상이다.
    if (truth[name] === null || truth[name] === undefined) {
      problems.push({ ...at, kind: 'unmeasurable', truthValue: null });
      continue;
    }
    const truthValue = String(truth[name]);

    // 값의 꼴을 먼저 본다. 정수도 ISO 날짜도 아니면 대조 자체가 불가능하다 —
    // **한글 수사(`여섯`)가 여기서 잡힌다.** 5차 리뷰가 찾은 것이 정확히 이 계열이고,
    // 숫자 축 정규식은 원리적으로 그것을 못 본다.
    if (!/^\d+$/.test(docValue) && !/^\d{4}-\d{2}-\d{2}$/.test(docValue)) {
      problems.push({ ...at, kind: 'unparsable', truthValue });
      continue;
    }

    // 같은 문서 안에서 같은 이름이 두 값을 들면 그 자체가 결함이다 —
    // 3·4차 blocker 가 둘 다 이 형상이었다(한 파일이 14와 15를, 47과 49를 동시에 단언).
    const key = `${a?.doc} ${name}`;
    if (seen.has(key) && seen.get(key) !== docValue) {
      problems.push({ ...at, kind: 'inconsistent', truthValue, otherValue: seen.get(key) });
      continue;
    }
    if (!seen.has(key)) seen.set(key, docValue);

    if (docValue !== truthValue) problems.push({ ...at, kind: 'mismatch', truthValue });
  }
  return problems;
}

/** HTML 에서 `data-verify` 선언을 뽑는다. 잎 요소에만 단다는 전제다. */
export function extractDocNumbers(html, docPath) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b[^>]*\bdata-verify="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      doc: docPath,
      line: html.slice(0, m.index).split('\n').length,
      name: m[2],
      value: m[3],
    });
  }
  return out;
}

if (argv.includes('--self-test')) {
  const D = 'harness/policy/phase-matrix.json';
  const ACK = { dep: D, sha: 'e8c47dd', why: '가드 필드 추가이고 이 문서가 옮겨 적는 값은 안 바뀌었다' };
  // 차단 쪽에 **`통과값 + 부정어` 짝**을 넣는다(R2): 면제가 억제로 변질되는 형상이
  // 이 판정의 본체다. 통과 케이스만 시험하면 그 계열은 영원히 안 잡힌다.
  const cases = [
    ['정상 면제',                 ACK,                                   D, 'e8c47dd1234', true],
    ['sha 접두 일치(짧은쪽)',      { ...ACK, sha: 'e8c47dd1234' },        D, 'e8c47dd',     true],
    ['배열 형태',                 [ACK],                                 D, 'e8c47dd',     true],
    ['의존이 바뀌었다 → 재무장',   ACK,                                   D, 'ffffffff',    false],
    ['다른 의존은 면제 안 됨',     ACK,                                   'harness/phase.py', 'e8c47dd', false],
    ['sha 없음 (fail-closed)',    { dep: D, why: '괜찮다' },              D, 'e8c47dd',     false],
    ['sha 빈 문자열',             { ...ACK, sha: '   ' },                D, 'e8c47dd',     false],
    ['why 없음 (근거 없는 면제)',  { dep: D, sha: 'e8c47dd' },            D, 'e8c47dd',     false],
    ['why 빈 문자열',             { ...ACK, why: '  ' },                 D, 'e8c47dd',     false],
    ['면제 기록 자체가 없음',      undefined,                             D, 'e8c47dd',     false],
    ['null',                     null,                                   D, 'e8c47dd',     false],
    ['문자열 (형식 오류)',         'ok',                                  D, 'e8c47dd',     false],
    ['빈 배열',                   [],                                    D, 'e8c47dd',     false],
    ['의존 sha 불명',             ACK,                                   D, '',            false],
    // M-1 (2026-08-04 리뷰) — **형식은 맞고 판별력만 없는 값**. 위 차단 케이스들은
    // 없음·빈 문자열·불일치라 전부 '틀린 값'인데, 이 계열은 '맞는 값처럼 보이는데
    // 검사를 끄는 값'이다. R2 가 인용한 두 우회와 같은 부류이고 하한 없이는 통과했다.
    ['sha 1글자 (판별력 없음)',    { ...ACK, sha: 'e' },                  D, 'e0000000',    false],
    ['sha 6글자 (하한 미달)',      { ...ACK, sha: 'e8c47d' },             D, 'e8c47dd1234', false],
    ['sha 7글자 (하한 경계·통과)',  { ...ACK, sha: 'e8c47dd' },            D, 'e8c47dd1234', true],
  ];
  let bad = 0;
  for (const [name, ack, dep, sha, want] of cases) {
    const got = judgeC2Ack(ack, dep, sha).exempt;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} 기대 ${want ? '면제' : '차단'} · 실측 ${got ? '면제' : '차단'}`);
  }
  // ── C7 수치 판정 ─────────────────────────────────────────────────────────
  // 차단 쪽에 **`통과값 + 부정어`** 형태를 넣는다(R2). 이 축에서 그 형상은
  // *"숫자는 맞는데 옆의 날짜만 틀린 것"* 과 *"숫자 자리에 숫자가 아닌 것"* 이다 —
  // 5차 리뷰가 찾은 셋 중 둘이 정확히 그것이고, 통과값만 시험하면 영원히 안 잡힌다.
  const T = { rows: '128', last: '2026-08-06', r1: '15' };
  const A = (name, value, doc = 'a.html', line = 1) => [{ doc, line, name, value }];
  const n7 = (arr) => judgeDocNumbers(arr, T).length;
  const c7 = [
    ['정상 일치(수)',              A('rows', '128'),                       true],
    ['정상 일치(날짜)',            A('last', '2026-08-06'),                true],
    ['태그가 끼어 있다',           A('rows', '<strong>128</strong>'),      true],
    ['천 단위 쉼표 · 공백',        A('rows', ' 1,28 '.replace('1,28', '128')), true],
    ['값이 다르다',                A('rows', '127'),                       false],
    ['날짜만 틀리다(수는 맞다)',    A('last', '2026-08-07'),                false],
    ['한글 수사',                  A('rows', '여섯'),                       false],
    ['숫자 + 단위 접미',           A('rows', '128행'),                      false],
    ['빈 값',                      A('rows', ''),                          false],
    ['모르는 이름',                A('nope', '128'),                       false],
    ['이름이 빈 문자열',           A('', '128'),                           false],
    ['대장 회차 일치',             A('r1', '15'),                          true],
    ['대장 회차 어긋남',           A('r1', '14'),                          false],
    ['한 문서가 두 값을 든다',
      [...A('rows', '128'), ...A('rows', '127', 'a.html', 9)],             false],
    ['다른 문서면 각각 판정',
      [...A('rows', '128'), ...A('rows', '128', 'b.html', 9)],             true],
    ['선언이 없으면 통과',         [],                                     true],
    ['null 안전',                  null,                                   true],
    // 정본을 못 재는 상태가 통과로 새면, 신선한 체크아웃에서만 꺼지는 검사가 된다(R9).
    ['정본을 잴 수 없다',          A('broken', '128'),                     false],
  ];
  T.broken = null;
  for (const [name, ann, want] of c7) {
    const got = n7(ann) === 0;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} 기대 ${want ? '통과' : '차단'} · 실측 ${got ? '통과' : '차단'}`);
  }

  // 추출기 축 — 판정이 옳아도 뽑지 못하면 검사는 없는 것과 같다.
  const ext = [
    ['div 잎 요소',   '<div class="num" data-verify="rows">128</div>',        1],
    ['span 잎 요소',  '<span data-verify="r1">15</span>',                     1],
    ['속성 순서 무관', '<span data-verify="rows" class="x">128</span>',        1],
    ['선언 없음',     '<div class="num">128</div>',                          0],
    ['둘 이상',       '<span data-verify="rows">1</span><b data-verify="r1">2</b>', 2],
  ];
  for (const [name, html, want] of ext) {
    const got = extractDocNumbers(html, 'a.html').length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} 기대 ${want}건 · 실측 ${got}건`);
  }

  const total = cases.length + c7.length + ext.length;
  console.log(bad ? `\n문서 신선도 자기시험 실패 ${bad}건 / ${total}건.` : `\n문서 신선도 자기시험 ${total}건 통과 (C2 면제 판정 ${cases.length} · C7 수치 판정 ${c7.length} · C7 추출 ${ext.length}).`);
  process.exit(bad ? 1 : 0);
}

// ── C2 결합 낡음 ────────────────────────────────────────────────────────────
const uncommittedDeps = [];
/** 면제로 통과한 것. **조용한 면제는 억제와 구별되지 않는다** — 반드시 출력한다. */
const c2Exempt = [];
/** C4 가 생성물이라 판정에서 뺀 참조. **조용한 제외는 범위를 숨긴다.** */
const excluded = [];
function checkC2() {
  for (const d of map.docs || []) {
    const deps = d.depends_on || DEFAULTS.depends_on || [];
    if (!deps.length) continue;
    for (const docPath of expand(d.path)) {
      const docCommit = lastCommit(docPath);
      // 문서 축의 면제(`MODE === 'pr' && changed.has(docPath)` → continue)는 **제거했다.**
      //
      // "이 PR이 문서를 동행시켰으면 책임을 다한 것이다"라는 가정이 틀렸다. 동행은
      // **건드렸다**는 뜻이지 **의존보다 나중이다**는 뜻이 아니다. 문서를 먼저 고치고
      // 그 다음 의존을 고치면 문서는 여전히 낡았는데 면제된다 — 그리고 그것이 정확히
      // 2026-07-27 B-d 가 새어나간 경로다(115커밋 브랜치에서 문서·의존이 둘 다 변경
      // 집합에 있어 이 줄이 전부 삼켰다).
      //
      // 아래 `:!changed.has(depFile)` (의존 축)은 **그대로 둔다.** 게이트 범위를 넓히는
      // 것은 그쪽이고, 넓히면 첫날부터 모든 PR 이 빨개져 게이트가 무시된다. 두 축은
      // 독립이므로 문서 축만 지워도 분모는 저장소 전체로 넓어지지 않는다.
      //
      // 판정 기준은 아래 `Date.parse(dc.time) > Date.parse(docCommit.time)` 시각 비교
      // 하나다 — 문서가 의존보다 **나중에** 커밋되면 통과한다. 고치는 법이 "문서를
      // 건드려라"가 아니라 "의존을 고친 뒤에 문서를 고쳐라"가 된다.
      if (!docCommit) continue; // 미커밋 문서는 낡을 수가 없다

      let worst = null;
      for (const dep of deps) {
        for (const depFile of expand(dep)) {
          if (depFile === docPath) continue;
          if (MODE === 'pr' && !changed.has(depFile)) continue; // ← C2의 PR 스코프
          const dc = lastCommit(depFile);
          if (!dc) {
            if (MODE === 'full') uncommittedDeps.push({ doc: docPath, dep: depFile, pattern: dep });
            continue;
          }
          if (Date.parse(dc.time) > Date.parse(docCommit.time)) {
            const ack = judgeC2Ack(d._c2_reviewed, depFile, dc.sha);
            if (ack.exempt) {
              c2Exempt.push({ doc: docPath, dep: depFile, sha: dc.sha, why: ack.why });
              continue;
            }
            if (!worst || Date.parse(dc.time) > Date.parse(worst.time)) {
              worst = { ...dc, file: depFile, pattern: dep, ackWhy: ack.why };
            }
          }
        }
      }
      if (!worst) continue;

      const gap = Math.round((Date.parse(worst.time) - Date.parse(docCommit.time)) / DAY);
      add('C2', docPath, [
        `[C2 결합 낡음] ${docPath}`,
        `  문서 최종 커밋 : ${fmt(docCommit.time)}  (${docCommit.sha})`,
        `  움직인 의존    : ${worst.file}  ${fmt(worst.time)}  (${worst.sha})  — 문서보다 ${gap}일 나중`,
        `                   ↳ depends_on 패턴: ${worst.pattern}`,
        `  고치는 법 — 셋 중 하나를 골라라:`,
        `    1) 문서를 갱신한다 — ${worst.file}의 변경을 ${docPath}에 반영하고 **같은 PR**에 넣는다. (기본 처방)`,
        `    2) 의존이 틀렸다 — doc-map.json에서 '${worst.pattern}'를 지우거나 더 좁게 고친다. 왜 무관한지를 _doc에 남긴다.`,
        `    3) 문서를 지운다 — 더 이상 무엇의 진실 공급원도 아니면 docs[]에서 빼고 파일도 지운다.`,
        `  (날짜만 고치는 4번째 길은 없다 — 갱신일은 git에서만 나오고 이 스크립트는 날짜를 쓰지 않는다.)`,
      ]);
    }
  }
}

// ── C3 나이 초과 ────────────────────────────────────────────────────────────
function checkC3() {
  for (const d of map.docs || []) {
    const limit = d.review_every_days ?? DEFAULTS.review_every_days ?? 90;
    for (const docPath of expand(d.path)) {
      const c = lastCommit(docPath);
      if (!c) continue;
      const age = ageDays(c.time);
      if (age > limit) {
        add('C3', docPath, [
          `${docPath} — ${age}일 경과 (검토 주기 ${limit}일, ${age - limit}일 초과)`,
          `  고치는 법: 읽고 (a) 여전히 맞으면 고칠 게 없다는 뜻이니 review_every_days를 늘려라, (b) 틀렸으면 고쳐라, (c) 아무도 안 읽으면 지워라.`,
        ]);
      }
    }
  }
}

// ── C4 링크·경로 무결성 ─────────────────────────────────────────────────────
const PATH_EXT = /\.(md|json|jsonl|ts|tsx|mjs|cjs|js|py|sh|ya?ml|html|css|txt|toml)$/;

/**
 * **gitignore 된 경로는 죽은 참조가 아니라 생성물이다.**
 *
 * 이 구분이 없으면 C4 는 **환경 의존 센서**가 된다 — `dist/server/main.js` 는
 * `npm run build` 를 돌린 머신에는 있고 신선한 체크아웃에는 없다. 그래서 이 검사는
 * 개발 머신에서 초록이고 CI 에서 빨갛다. 문서(`docs/adr/0006-deployment.md`)는 그
 * 경로를 **정당하게** 인용한다 — 배포 산출물의 이름이 그것이기 때문이다.
 *
 * 2026-07-29 에 `doc-freshness --pr` 을 `ci.yml` 에 처음 배선하면서 드러났다.
 * **그 전까지 이 검사는 빌드 산출물이 있는 머신에서만 돌았고, 아무도 몰랐다.**
 * "센서가 환경에 따라 다른 답을 내면 그 센서는 판정에 쓸 수 없다"가 여기의 교훈이다.
 *
 * 판정은 `git check-ignore --stdin` 한 번으로 일괄한다(경로마다 서브프로세스를 띄우면
 * 문서 수에 비례해 느려진다). git 을 못 부르면 **아무것도 무시하지 않는다** —
 * 판정 불가일 때 통과시키는 쪽이 아니라 원래대로 두는 쪽이다.
 */
function ignoredPaths(candidates) {
  if (!candidates.length) return new Set();
  const r = spawnSync('git', ['check-ignore', '--stdin'],
    { cwd: ROOT, input: candidates.join('\n'), encoding: 'utf8' });
  // exit 0 = 하나 이상 무시됨, 1 = 무시된 것 없음, 그 외 = 오류
  if (r.status !== 0 && r.status !== 1) return new Set();
  return new Set((r.stdout || '').split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean));
}

function checkC4() {
  const fileSet = new Set(files);
  for (const d of map.docs || []) {
    for (const docPath of expand(d.path)) {
      if (!docPath.endsWith('.md')) continue;
      const abs = join(ROOT, docPath);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8').replace(/```[\s\S]*?```/g, ''); // 펜스 코드는 예시다
      const dead = [];
      const seen = new Set();

      const consider = (raw, kind) => {
        const t = raw.trim().split('#')[0].trim();
        if (!t || seen.has(t)) return;
        if (/^(https?:|mailto:|tel:|data:|#)/.test(t)) return;
        if (/[\s<>|"'`${}()]/.test(t)) return;
        if (kind === 'backtick' && !t.includes('/')) return;
        if (kind === 'backtick' && !PATH_EXT.test(t) && !t.endsWith('/')) return;
        seen.add(t);
        const candidates = [t.replace(/^\.\//, ''), posix.normalize(posix.join(posix.dirname(docPath), t))];
        for (const c of candidates) {
          const bare = c.replace(/\/+$/, '');
          if (/[*?]/.test(bare)) {
            if (files.some((f) => matches(bare, f))) return;
            // git ls-files는 gitignore된 경로를 모른다. _workspace/review/*.md 처럼
            // 추적되지 않지만 실재하는 디렉터리를 죽은 참조로 몰지 않으려면 디스크도 봐야 한다.
            const star = bare.search(/[*?]/);
            const dir = bare.slice(0, bare.lastIndexOf('/', star) + 1);
            if (dir && existsSync(join(ROOT, dir))) {
              try {
                if (readdirSync(join(ROOT, dir)).some((n) => matches(bare, dir + n))) return;
              } catch {
                /* 읽을 수 없으면 판정하지 않는다 */
              }
            }
          } else if (fileSet.has(bare) || existsSync(join(ROOT, bare))) {
            return;
          }
        }
        dead.push({ ref: t, kind });
      };

      for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) consider(m[1], 'link');
      for (const m of text.matchAll(/`([^`\n]+)`/g)) consider(m[1], 'backtick');

      // 생성물(gitignore 대상)은 판정에서 뺀다 — 있고 없고가 환경에 달렸다.
      // **뺀 것은 반드시 찍는다.** 조용한 제외는 이 저장소가 golden-coverage 분모에서
      // 이미 겪은 병이고, eval-b 가 `blocked` 를 뺄 때마다 이름과 사유를 찍는 이유도
      // 같다. `_workspace/**` 도 gitignore 이므로 리뷰 보고서 경로가 사라져도 C4 는
      // 침묵한다 — 그 사실이 출력에 보여야 읽는 사람이 범위를 안다.
      const ignored = ignoredPaths(dead.map((x) => x.ref.replace(/^\.\//, '')));
      if (ignored.size) {
        excluded.push(`${docPath}: ${[...ignored].join(' · ')}`);
      }
      for (const x of dead.filter((x) => !ignored.has(x.ref.replace(/^\.\//, '')))) {
        add('C4', docPath, [
          `${docPath} → 죽은 ${x.kind === 'link' ? '링크' : '경로 참조'}: ${x.ref}`,
          `  고치는 법: 파일이 이동했으면 참조를 고치고, 사라졌으면 문장째 지워라. 예시 경로라면 펜스 코드 블록에 넣어라 — 이 검사는 펜스 안을 보지 않는다.`,
        ]);
      }
    }
  }
}

// ── C5 진입점 예산 ──────────────────────────────────────────────────────────
function checkC5() {
  for (const d of map.docs || []) {
    if (!d.max_lines) continue;
    for (const docPath of expand(d.path)) {
      const abs = join(ROOT, docPath);
      if (!existsSync(abs)) continue;
      const n = readFileSync(abs, 'utf8').split('\n').length;
      if (n > d.max_lines) {
        add('C5', docPath, [
          `${docPath} — ${n}줄 (예산 ${d.max_lines}줄, ${n - d.max_lines}줄 초과)`,
          `  고치는 법: 내용을 지우지 말고 **옮겨라**. 진입점 문서는 백과사전이 아니라 목차다 —`,
          `  상세는 참조 파일로 빼고 여기엔 "어떤 작업에 무엇을 읽어라" 한 줄만 남겨라. (안티패턴 01의 유일한 기계 방어)`,
        ]);
      }
    }
  }
}

// ── C6 열린 마커 낡음 ───────────────────────────────────────────────────────
function blameTimes(path) {
  const out = git(['blame', '--line-porcelain', '--', path]);
  if (out === null) return null;
  const times = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('committer-time ')) cur = Number(line.slice('committer-time '.length)) * 1000;
    else if (line.startsWith('\t')) times.push(cur);
  }
  return times;
}
function checkC6() {
  const def = CHECKS.C6 || {};
  if (!def.marker_pattern) return;
  const re = new RegExp(def.marker_pattern, 'u');
  const staleAfterDays = def.stale_after_days ?? 14;
  for (const d of map.docs || []) {
    const tier = d.tier ?? DEFAULTS.tier ?? 2;
    if (tier > 2) continue;
    for (const docPath of expand(d.path)) {
      const abs = join(ROOT, docPath);
      if (!docPath.endsWith('.md') || !existsSync(abs)) continue;
      const lines = readFileSync(abs, 'utf8').split('\n');
      const hits = [];
      lines.forEach((l, i) => {
        if (re.test(l)) hits.push(i);
      });
      if (!hits.length) continue;
      const times = blameTimes(docPath);
      const stale = [];
      for (const i of hits) {
        const t = times && times[i] != null ? times[i] : null;
        if (t === null) continue; // 미커밋 줄 — 오늘 쓴 것이므로 낡을 수 없다
        const age = Math.floor((NOW - t) / DAY);
        if (age > staleAfterDays) stale.push({ line: i + 1, age, text: lines[i].trim().slice(0, 90) });
      }
      if (!stale.length) continue;
      add('C6', docPath, [
        `${docPath} — ${staleAfterDays}일 넘게 열려 있는 마커 ${stale.length}건`,
        ...stale.slice(0, 6).map((s) => `    L${s.line} (${s.age}일)  ${s.text}`),
        `  고치는 법: 마커마다 (a) 이미 해결됐으면 ✅로 닫아라, (b) 아직이면 docs/progress.md 원장에 행을 만들고 문서에서는 지워라.`,
        `  둘 다 아니면 그 마커는 아무도 안 볼 것이므로 지우는 게 정직하다.`,
      ]);
    }
  }
}

// ── C7 문서 수치 대조 ───────────────────────────────────────────────────────
//
// **허용 목록이다.** 문서가 이름을 대면 여기 있는 계산만 돈다 — 문서가 셸 명령을
// 시키지 못한다. 목록에 이번 PR 에서 **실제로 낡았던 축만** 넣는다(추측으로 늘리면
// 안 쓰이는 측정이 쌓이고, 그것은 죽은 설정이 판단의 흔적처럼 읽히는 자리가 된다).
// `git ls-files` 하나만 `spawnSync` 로 부르고 그것은 `tool-risk.json` 의 R0(읽기 전용)다.
function readLinesOrNull(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').split('\n');
}
function countMatching(rel, re) {
  const lines = readLinesOrNull(rel);
  return lines === null ? null : lines.filter((l) => re.test(l)).length;
}
/** `## 대장` 절의 표 행만. **같은 파일의 다른 표를 세면 안 된다** — P11 이 같은 함정에 걸린 적이 있다. */
function ledgerRows() {
  const lines = readLinesOrNull('harness/recurrence.md');
  if (lines === null) return null;
  const start = lines.findIndex((l) => /^##\s*대장\s*$/.test(l));
  if (start < 0) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = /^\|\s*(R\d+)\s*\|/.exec(lines[i]);
    if (!m) continue;
    const cells = lines[i].split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim());
    rows.push({ id: m[1], count: (cells[2] || '').replace(/\*/g, '').trim() });
  }
  return rows;
}
/** `docs/progress.md` 보류표 — 헤더를 찾아 그 절의 데이터 행만 센다(줄 번호를 박지 않는다). */
function pendingRows() {
  const lines = readLinesOrNull('docs/progress.md');
  if (lines === null) return null;
  const start = lines.findIndex((l) => /^\|\s*보류 항목\s*\|/.test(l));
  if (start < 0) return null;
  let n = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (/^\|\s*-+/.test(lines[i])) continue;
    if (/^\|/.test(lines[i])) n++;
  }
  return n;
}
function jsonOrNull(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function dirCount(rel, filter) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return readdirSync(p, { withFileTypes: true }).filter(filter).length; } catch { return null; }
}

function buildMeasures() {
  const m = {};
  m['changelog-rows'] = countMatching('docs/harness/changelog.md', /^\| 2026/);
  const clDates = (readLinesOrNull('docs/harness/changelog.md') || [])
    .map((l) => /^\|\s*(\d{4}-\d{2}-\d{2})/.exec(l)?.[1]).filter(Boolean).sort();
  m['changelog-last-date'] = clDates.length ? clDates[clDates.length - 1] : null;
  m['pending-rows'] = pendingRows();
  const pl = readLinesOrNull('docs/progress.md');
  // `wc -l` 은 마지막 개행 뒤의 빈 조각을 세지 않는다 — 문서가 그 명령을 정본으로 적으므로 맞춘다.
  m['progress-lines'] = pl === null ? null : (pl.length && pl[pl.length - 1] === '' ? pl.length - 1 : pl.length);
  const led = ledgerRows();
  m['recurrence-rows'] = led === null ? null : led.length;
  for (const r of led || []) m[`recurrence-${r.id}`] = r.count || null;
  const ga = readLinesOrNull('evals/golden/track-a-product.jsonl');
  const gb = readLinesOrNull('evals/golden/track-b-harness.jsonl');
  const cnt = (l) => (l === null ? null : l.filter((s) => s.trim()).length);
  m['golden-a'] = cnt(ga);
  m['golden-b'] = cnt(gb);
  m['golden-total'] = m['golden-a'] === null || m['golden-b'] === null ? null : m['golden-a'] + m['golden-b'];
  m['adr-approved'] = dirCount('docs/adr', (e) => e.isFile() && /^\d{4}-/.test(e.name) && !e.name.startsWith('0000-'));
  const pm = jsonOrNull('harness/policy/phase-matrix.json');
  m['phases'] = pm?.phases ? Object.keys(pm.phases).length : null;
  m['edges'] = pm?.transitions
    ? Object.values(pm.transitions).reduce((a, v) => a + (Array.isArray(v) ? v.length : 1), 0)
    : null;
  m['guards'] = pm?.guards ? Object.keys(pm.guards).length : null;
  m['agents'] = dirCount('.claude/agents', (e) => e.isFile() && e.name.endsWith('.md'));
  m['skills'] = dirCount('.claude/skills', (e) => e.isDirectory());
  const pj = readLinesOrNull('.harness/state/phase.jsonl');
  m['force-count'] = pj === null ? null : pj.filter((l) => {
    if (!l.trim()) return false;
    try { return JSON.parse(l).forced === true; } catch { return false; }
  }).length;
  const ls = git(['ls-files', 'evals/results/track-b/']);
  m['trackb-artifacts'] = ls === null ? null : ls.split('\n').filter((s) => s.trim()).length;
  return m;
}

const KIND_TEXT = {
  mismatch: (p) => `문서 "${p.docValue}" · 실측 "${p.truthValue}"`,
  unparsable: (p) => `"${p.docValue}" 는 수도 날짜도 아니다 — 대조할 수 없다 (실측 "${p.truthValue}")`,
  unknown: (p) => `측정 이름 "${p.name}" 이 허용 목록에 없다`,
  unmeasurable: () => `정본을 잴 수 없다 — 근거 파일이 없거나 형식이 깨졌다`,
  inconsistent: (p) => `같은 문서가 "${p.otherValue}" 와 "${p.docValue}" 를 둘 다 단언한다 (실측 "${p.truthValue}")`,
};

function checkC7() {
  const truth = buildMeasures();
  for (const d of map.docs || []) {
    for (const docPath of expand(d.path)) {
      if (!/\.html?$/i.test(docPath)) continue;
      const abs = join(ROOT, docPath);
      if (!existsSync(abs)) continue;
      const problems = judgeDocNumbers(extractDocNumbers(readFileSync(abs, 'utf8'), docPath), truth);
      if (!problems.length) continue;
      add('C7', docPath, [
        `${docPath} — 정본과 어긋난 수치 ${problems.length}건`,
        ...problems.slice(0, 12).map((p) => `    L${p.line}  ${p.name}: ${KIND_TEXT[p.kind](p)}`),
        `  고치는 법: 문서의 값을 실측으로 고쳐라. 값이 계속 움직이는 축이면(전이 수·아티팩트 수처럼)`,
        `  값을 빼고 재현 명령만 남겨라 — data-verify 선언을 지우면 이 검사도 함께 빠진다 (대장 R10).`,
        `  측정 이름이 허용 목록에 없으면 scripts/doc-freshness.mjs 의 buildMeasures() 에 추가해야 한다.`,
      ]);
    }
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const RUN = MODE === 'digest' ? ['C1', 'C2', 'C3', 'C5'] : ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
const RUNNER = { C1: checkC1, C2: checkC2, C3: checkC3, C4: checkC4, C5: checkC5, C6: checkC6, C7: checkC7 };
for (const id of RUN) RUNNER[id]();

const by = (c) => findings.filter((f) => f.check === c);
const blocking = findings.filter((f) => f.severity === 'blocking' || (STRICT && f.severity === 'advisory'));

if (MODE === 'digest') {
  // ≤5줄. SessionStart 훅은 컨텍스트 예산을 쓰는 자리다 — 여기서 장황하면 훅 자체가 비용이 된다.
  console.log(
    `문서 신선도: 미등록 ${by('C1').length} · 낡음 ${by('C2').length} · 나이초과 ${by('C3').length} · 예산초과 ${by('C5').length}`
  );
  const top = [...by('C1'), ...by('C5'), ...by('C2')].slice(0, 3);
  for (const f of top) console.log(`  ⚠ [${f.check}] ${f.doc}`);
  if (!top.length) console.log('  이상 없음.');
  console.log('  자세히: node scripts/doc-freshness.mjs --full');
  process.exit(0);
}

console.log(
  `문서 신선도 검사 — 모드: ${MODE}${MODE === 'pr' ? ` (base: ${baseUsed}, 변경 파일 ${changed.size}개)` : ''}${STRICT ? ' [strict]' : ''}`
);
console.log(
  `레지스트리 ${(map.docs || []).length}항목 → 실파일 ${new Set((map.docs || []).flatMap((d) => expand(d.path))).size}개 · governed_globs 일치 ${governed.length}개`
);
console.log('');

// **C4 가 무엇을 판정에서 뺐는지 반드시 찍는다.** 조용한 제외는 검사 범위를 숨긴다 —
// `_workspace/**` 도 gitignore 이므로 리뷰 보고서 경로가 사라져도 C4 는 침묵한다.
// 이 저장소는 같은 답을 이미 갖고 있다: `eval-b` 가 `blocked` 를 뺄 때마다 이름과
// 사유를 찍고, `golden-coverage` 의 분모 사건이 조용한 제외의 대가를 실증했다.
if (excluded.length) {
  console.log(`  C4 판정 제외 (gitignore 대상 = 생성물) — ${excluded.length}개 문서:`);
  for (const e of excluded) console.log(`    ${e}`);
  console.log('');
}

// 같은 이유로 C2 면제도 반드시 찍는다. **조용한 면제는 억제와 구별되지 않는다** —
// 읽는 사람이 "검사가 통과했다"와 "검사를 껐다"를 가려낼 수 있어야 한다.
if (c2Exempt.length) {
  console.log(`  C2 면제 (검토 기록 있음 — sha 가 바뀌면 자동 재무장) — ${c2Exempt.length}건:`);
  for (const e of c2Exempt) console.log(`    ${e.doc} ← ${e.dep} @${e.sha}\n      사유: ${e.why}`);
  console.log('');
}

for (const [id, def] of Object.entries(CHECKS)) {
  const list = by(id);
  const isBlocking = list.some((f) => f.severity === 'blocking');
  const sev = id === 'C2' && MODE !== 'pr' && def.advisory_scope ? 'advisory(repo)' : def.severity;
  const mark = !RUN.includes(id) ? 'SKIP' : list.length === 0 ? 'PASS' : isBlocking ? 'FAIL' : 'WARN';
  console.log(`  ${mark}  ${id} ${def.name}  [${sev}]${list.length ? ` — ${list.length}건` : ''}`);
}
console.log('');

for (const id of Object.keys(CHECKS)) {
  const list = by(id);
  if (!list.length) continue;
  console.log(`── ${id} ${CHECKS[id].name} — ${list.length}건 ${'─'.repeat(40)}`);
  for (const f of list) for (const l of f.lines) console.log(l);
  console.log('');
}

if (MODE === 'full') {
  if (uncommittedDeps.length) {
    console.log('── 미커밋 의존 (아직 C2를 켜지 않았지만, 커밋되는 순간 켜진다) ─────────────');
    for (const u of uncommittedDeps.slice(0, 12)) console.log(`  ${u.doc} ← ${u.dep}  (패턴: ${u.pattern})`);
    if (uncommittedDeps.length > 12) console.log(`  … 외 ${uncommittedDeps.length - 12}건`);
    console.log('');
  }
  console.log('── 처방 ─────────────────────────────────────────────────────────────────');
  if (!findings.length) {
    console.log('  없음. 문서와 코드가 같은 시각을 가리키고 있다.');
  } else {
    const hardCount = by('C1').length + by('C4').length + by('C5').length;
    if (hardCount) console.log(`  ! 차단 등급(C1/C4/C5) ${hardCount}건 — 판단이 아니라 사실 오류다. 먼저 고쳐라.`);
    if (by('C2').length)
      console.log(`  1) C2 ${by('C2').length}건 — 가장 오래 벌어진 것부터 하나씩 닫아라. 한꺼번에 닫으면 문서 커밋이 코드와 분리돼 다음 주에 또 벌어진다.`);
    if (by('C3').length)
      console.log(`  2) C3 ${by('C3').length}건 — 검토 주기가 현실과 안 맞는다는 신호일 수 있다. 고칠 게 없는 문서는 주기를 늘리는 쪽이 정직하다.`);
    if (by('C6').length) console.log(`  3) C6 ${by('C6').length}건 — 열린 마커는 "나중에"의 다른 이름이다. 원장으로 옮기거나 닫아라.`);
  }
  console.log('');
}

if (blocking.length) {
  console.log(`실패 — 차단 등급 ${blocking.length}건 (${[...new Set(blocking.map((b) => b.check))].join(', ')}).`);
  process.exit(1);
}
console.log(`통과 — 차단 등급 0건${findings.length ? ` · advisory ${findings.length}건 (위 처방 참고)` : ''}.`);
process.exit(0);
