#!/usr/bin/env node
/**
 * scripts/golden-coverage.mjs — 센서 계열 S3 (요구사항 충족).
 *
 * 질문: "스펙이 시킨 걸 했나?"   기질: specs/requirements.md + evals/golden.
 * **이 계열만 잡는 실패**: 테스트가 전부 초록인데 어떤 요구사항에 해당하는 검증이 **아예 없다**.
 * S2(테스트 실행)로는 원리적으로 관측 불가능하다 — 없는 테스트는 실패하지 않는다.
 * 없는 테스트는 조용하다. 그 침묵을 소리로 바꾸는 것이 이 스크립트의 전부다.
 *
 * **분모는 요구사항이다** (2026-07-27 변경). 그 전에는 분모가 골든 파일의 GA 케이스였고,
 * 그래서 GA 케이스가 없는 RQ는 "미커버"로 셀 수조차 없었다. 실측에서 RQ 14개 중
 * 3개(RQ-05·16·17)가 그 상태였는데 센서는 `"대상 27건 · 커버 27 · 미커버 0"`을 냈다.
 * 읽는 사람은 그 줄을 "요구사항이 다 커버됐다"로 읽는다 — **분모에 없는 것은 실패하지
 * 않는다.** 분모를 specs/requirements.md에서 유도하면 RQ가 분모 밖에 있는 상태가
 * 구성상 존재할 수 없다. 이 변경이 "센서 추가"가 아니라 "구조 수정"인 이유다.
 *
 * 각 RQ를 4분류한다:
 *   GA 커버   — 골든 케이스 + 실행되는 테스트 (evals/golden/track-a-product.jsonl의 spec에서 유도)
 *   스모크    — scripts/smoke.sh가 배포 아티팩트에서 검증 (harness/rq-coverage.json)
 *   제약 충족 — ADR의 구조적 제약이며 별도 테스트 대상 아님 (harness/rq-coverage.json)
 *   미커버    — 어디에도 없음 → **차단(exit 1)**
 *
 * "사양 대조 없는 테스트 통과는 완료가 아니다"의 기계적 집행 지점.
 *
 *   node scripts/golden-coverage.mjs              전 RQ
 *   node scripts/golden-coverage.mjs --rq RQ-13   해당 RQ만 (GREEN→EVAL 전이 가드가 이 형태로 부른다)
 *   node scripts/golden-coverage.mjs --run        vitest를 실제로 돌려 "이름 붙은 테스트가 진짜 도는지" 대조
 *   node scripts/golden-coverage.mjs --orphans    골든에 매이지 않은 테스트 파일도 보고
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REQUIREMENTS = join(ROOT, 'specs/requirements.md');
const GOLDEN = join(ROOT, 'evals/golden/track-a-product.jsonl');
const MAPPING = join(ROOT, 'harness/rq-coverage.json');
const VITEST_CFG = join(ROOT, 'vitest.config.ts');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/golden-coverage.mjs [--rq RQ-XX] [--run] [--orphans]');
  console.log('  (인자 없음)  specs/requirements.md의 RQ 전수를 4분류(GA/스모크/제약/미커버). 미커버 ≥1이면 exit 1');
  console.log('  --rq RQ-XX   해당 RQ만 (GREEN→EVAL 전이 가드가 이 형태로 부른다)');
  console.log('  --run        vitest를 실제로 돌려 "이름 붙은 테스트가 진짜 도는지" 대조');
  console.log('  --orphans    어떤 GA 케이스도 verify로 지목하지 않는 테스트 파일 보고');
  process.exit(0);
}
const RQ = (() => {
  const i = argv.indexOf('--rq');
  return i >= 0 && argv[i + 1] ? argv[i + 1].toUpperCase() : null;
})();
const DO_RUN = argv.includes('--run');
const SHOW_ORPHANS = argv.includes('--orphans');

/** 터미널 열 폭 — 한글은 2칸을 먹는다. 한글 라벨을 padEnd로 맞추면 표가 어긋난다. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
function pad(s, n) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(1, n - w));
}
const byId = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

// ── 분모: specs/requirements.md의 RQ 전수 ───────────────────────────────────
// 이 블록이 이 센서의 심장이다. 여기서 RQ를 하나라도 놓치면 그 RQ는 영원히 초록이다.
if (!existsSync(REQUIREMENTS)) {
  console.error('specs/requirements.md가 없다 — 분모가 없으므로 "요구사항이 커버됐는가"를 물을 수 없다.');
  console.error('고치는 법: 이 저장소의 진실 공급원 #1이다(CLAUDE.md). 경로가 바뀌었다면 이 스크립트의 REQUIREMENTS 상수도 함께 고쳐라.');
  process.exit(1);
}
const RQ_DEF = /^[ \t]*-[ \t]+\*\*(RQ-\d+)\*\*/gm;
const reqIds = [];
const reqDupes = [];
for (const m of readFileSync(REQUIREMENTS, 'utf8').matchAll(RQ_DEF)) {
  if (reqIds.includes(m[1])) reqDupes.push(m[1]);
  else reqIds.push(m[1]);
}
// 패턴이 죽으면 분모가 0이 되고, 0/0은 "전부 커버"처럼 보인다. P8(매칭 불가능한 패턴)과
// 같은 실패 양식이라 같은 처방을 쓴다 — 매칭 능력의 부재를 통과가 아니라 실패로 낸다.
if (reqIds.length === 0) {
  console.error('specs/requirements.md에서 RQ를 하나도 찾지 못했다 — 분모가 0이다.');
  console.error(`고치는 법: 이 스크립트는 "- **RQ-XX**" 형태의 항목 정의를 센다(정규식 ${RQ_DEF.source}).`);
  console.error('  요구사항 문서의 서식이 바뀌었다면 정규식을 함께 고쳐라. 분모 0을 통과로 내면 이 센서는 영구히 초록이다.');
  process.exit(1);
}

// ── 골든 로드 ───────────────────────────────────────────────────────────────
if (!existsSync(GOLDEN)) {
  console.error('evals/golden/track-a-product.jsonl이 없다.');
  console.error('고치는 법: 골든 셋 없이는 "스펙이 시킨 걸 했는가"를 물을 수 없다.');
  console.error('  evals/README.md의 절차로 트랙 A 케이스를 만들어라 — RQ의 수용 기준 한 줄이 곧 한 케이스다.');
  process.exit(1);
}
const cases = [];
readFileSync(GOLDEN, 'utf8')
  .split(/\r?\n/)
  .forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      cases.push({ ...JSON.parse(t), _line: i + 1 });
    } catch (e) {
      console.error(`골든 파일 L${i + 1} JSON 파싱 실패: ${e.message}`);
      console.error('고치는 법: JSONL은 한 줄 = 한 객체다. 객체 안에 줄바꿈이 들어갔는지 확인하라.');
      process.exit(1);
    }
  });

// ── 매핑 로드: GA 케이스가 없지만 다른 경로로 검증되는 RQ ───────────────────
// 파일이 없어도 죽지 않는다. 다만 그 RQ들이 미커버로 잡히므로 침묵하지도 않는다.
const integrity = []; // 파일 수준 무결성 문제 — 특정 RQ의 상태가 아니라 매핑 파일 자체의 문제
const rqProblems = new Map(); // RQ → 그 RQ의 커버리지 주장을 무효화하는 문제들
function rqFail(rq, what, how) {
  if (!rqProblems.has(rq)) rqProblems.set(rq, []);
  rqProblems.get(rq).push({ what, how });
}

let mapping = {};
let mappingMissing = false;
if (!existsSync(MAPPING)) {
  mappingMissing = true;
} else {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(MAPPING, 'utf8'));
  } catch (e) {
    console.error(`harness/rq-coverage.json JSON 파싱 실패: ${e.message}`);
    console.error('고치는 법: 파싱 실패는 fail-closed다 — 매핑을 읽을 수 없으면 스모크·제약 분류가 전부 사라진다.');
    console.error('  node -e "JSON.parse(require(\'fs\').readFileSync(\'harness/rq-coverage.json\',\'utf8\'))" 로 위치를 확인하라.');
    process.exit(1);
  }
  for (const [rq, entry] of Object.entries(raw.rq || {})) {
    const id = rq.toUpperCase();
    if (!reqIds.includes(id)) {
      integrity.push({
        what: `harness/rq-coverage.json이 ${id}를 매핑하는데 specs/requirements.md에 그런 RQ가 없다`,
        how: `RQ ID 오타이거나 삭제된 요구사항이다. 매핑에서 빼거나 ID를 고쳐라 (요구사항: ${reqIds.join(', ')}).`,
      });
      continue;
    }
    const kind = String(entry?.kind || '');
    if (kind === 'golden') {
      rqFail(
        id,
        `harness/rq-coverage.json이 ${id}를 golden으로 적었다 — golden 분류는 이 파일이 쓰는 것이 아니다`,
        'golden 매핑은 evals/golden/track-a-product.jsonl의 spec 필드에서 유도한다. 같은 사실을 두 곳에 적으면 반드시 어긋나고, 어긋났을 때 어느 쪽이 진실인지 아무도 모른다. 이 항목을 지워라.'
      );
      continue;
    }
    if (kind !== 'smoke' && kind !== 'constraint') {
      rqFail(
        id,
        `harness/rq-coverage.json의 ${id}.kind가 'smoke'|'constraint'가 아니다: ${JSON.stringify(entry?.kind)}`,
        "배포 아티팩트에서 검증되면 'smoke', ADR의 구조적 제약이면 'constraint'다. 둘 다 아니면 GA 케이스를 만들어야 한다."
      );
      continue;
    }
    if (!String(entry.why || '').trim()) {
      rqFail(
        id,
        `harness/rq-coverage.json의 ${id}에 why가 없다 — 왜 별도 테스트 대상이 아닌지 아무도 안 적었다`,
        '다음 사람이 이 항목을 보고 "면제해도 되는 건가"를 판단할 수 있어야 한다. why에 근거를 문장으로 적어라.'
      );
      continue;
    }
    const refs = Array.isArray(entry.refs) ? entry.refs : [];
    if (refs.length === 0) {
      rqFail(
        id,
        `harness/rq-coverage.json의 ${id}에 refs가 없다 — 근거 파일을 대지 않았다`,
        'refs에 근거 파일 경로를 적어라 (smoke면 scripts/smoke.sh, constraint면 docs/adr/NNNN-*.md). 근거 없는 분류는 검증 면제 목록이지 매핑이 아니다.'
      );
      continue;
    }
    const missing = refs.filter((p) => !existsSync(join(ROOT, p)));
    if (missing.length) {
      rqFail(
        id,
        `harness/rq-coverage.json의 ${id}.refs에 실재하지 않는 경로가 있다: ${missing.join(', ')}`,
        '경로가 바뀌었거나 파일이 지워졌다. 근거가 사라졌으면 분류도 다시 봐야 한다 — 경로를 고치거나 이 RQ의 검증 경로를 새로 정하라.'
      );
      continue;
    }
    // 근거 파일 중 최소 하나가 이 RQ를 실제로 언급해야 한다. 이 검사가 이 파일이
    // "검증 면제 목록"으로 쓰이는 것을 막는 유일한 장치다 — 다만 막는 것은 '근거가
    // 그 RQ를 다룬다'까지이지 '그 주장이 옳다'가 아니다. 뒤쪽은 사람의 일이다.
    const named = refs.filter((p) => readFileSync(join(ROOT, p), 'utf8').includes(id));
    if (named.length === 0) {
      rqFail(
        id,
        `harness/rq-coverage.json의 ${id}.refs 중 어느 파일도 ${id}를 언급하지 않는다`,
        `근거 파일이 이 RQ를 다룬다는 흔적이 없다. 그 파일(${refs[0]} 등)에 ${id}를 명시하거나, ${id}를 실제로 다루는 문서를 refs에 넣어라.`
      );
      continue;
    }
    mapping[id] = { kind, why: entry.why, refs, named, scopeNote: entry.scope_note || null };
  }
}

// ── vitest가 실제로 집는 파일인가 ───────────────────────────────────────────
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
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function vitestIncludes() {
  const fallback = ['tests/**/*.test.ts', 'tests/**/*.test.tsx'];
  if (!existsSync(VITEST_CFG)) return fallback;
  const m = readFileSync(VITEST_CFG, 'utf8').match(/include:\s*\[([^\]]*)\]/);
  if (!m) return fallback;
  const list = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
  return list.length ? list : fallback;
}
const includes = vitestIncludes().map((g) => ({ glob: g, re: globToRegExp(g) }));
const runnable = (p) => includes.some((i) => i.re.test(p));

// ── 테스트 파일에서 "실제로 도는 이름"만 추출 ───────────────────────────────
/**
 * describe/it/test 호출의 **제목 문자열만** 본다.
 *
 *   - 주석의 GA-22 언급은 커버가 아니다. 주석은 실행되지 않는다.
 *   - `.skip` / `.todo` / `.failing` 은 커버가 아니다.
 *   - **바깥 describe가 .skip이면 안쪽 it도 커버가 아니다.** 이 중첩 판정 때문에
 *     정규식 한 방이 아니라 중괄호 깊이를 세는 스캐너가 필요하다. 정규식만 쓰면
 *     `describe.skip(() => { it('GA-03') })` 가 "커버됨"으로 통과한다 —
 *     "이름은 붙어 있는데 돌지 않는" 상태가 이 검사가 노리는 가장 교활한 실패다.
 *     골든에는 done이라 적혀 있고 CI는 초록이다.
 *
 * 문자열·주석 안의 중괄호를 세지 않기 위해 최소한의 어휘 상태만 추적한다.
 * 완전한 파서가 아니다 — 테스트 파일이 쓰는 문법 범위에서만 정확하다.
 */
const CALL_RE = /\b(describe|it|test)((?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3/y;
const NON_RUNNING = /^\.(skip|todo|failing|skipIf)\b/;

function parseTests(src) {
  const calls = [];
  const stack = []; // 열려 있는 블록들 — 각 원소는 그 블록을 연 call(없으면 null)
  let pending = null; // 인자 목록은 지나갔고 콜백 본문 '{' 를 기다리는 call
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // 주석
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }

    // 문자열·템플릿 (템플릿 안의 ${} 는 문자열로 취급 — 테스트 제목에 중괄호를 넣는 경우는 없다)
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === '{') {
      stack.push(pending);
      pending = null;
      i++;
      continue;
    }
    if (c === '}') {
      stack.pop();
      i++;
      continue;
    }

    // describe/it/test 호출
    if (c === 'd' || c === 'i' || c === 't') {
      const prev = i > 0 ? src[i - 1] : ' ';
      if (!/[\w$.]/.test(prev)) {
        CALL_RE.lastIndex = i;
        const m = CALL_RE.exec(src);
        if (m && m.index === i) {
          const call = {
            kind: m[1],
            mod: m[2] || '',
            title: m[4],
            selfRunning: !NON_RUNNING.test(m[2] || ''),
            ancestors: stack.filter(Boolean),
          };
          calls.push(call);
          pending = call;
          i = CALL_RE.lastIndex;
          continue;
        }
      }
    }
    i++;
  }
  for (const c of calls) c.running = c.selfRunning && c.ancestors.every((a) => a.selfRunning);
  return calls;
}

const titleCache = new Map();
function titlesOf(relPath) {
  if (!titleCache.has(relPath)) {
    const abs = join(ROOT, relPath);
    titleCache.set(relPath, existsSync(abs) ? parseTests(readFileSync(abs, 'utf8')) : []);
  }
  return titleCache.get(relPath);
}

function listTestFiles(dir = 'tests') {
  if (!existsSync(join(ROOT, dir))) return [];
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...listTestFiles(rel));
    else if (/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// ── 범위 결정 ───────────────────────────────────────────────────────────────
if (RQ && !reqIds.includes(RQ)) {
  console.error(`specs/requirements.md에 ${RQ}가 없다 — 분모에 없는 것은 검사할 수도 없다.`);
  console.error('고치는 법 — 둘 중 하나다:');
  console.error(`  1) RQ ID 오타를 고쳐라 (요구사항: ${reqIds.join(', ')})`);
  console.error('  2) 새 요구사항이라면 specs/requirements.md에 "- **RQ-XX** …" 항목을 먼저 적어라.');
  console.error('     스펙에 없는 것을 구현하는 것이 스코프 크리프다 (CLAUDE.md 금지 항목).');
  process.exit(1);
}
const targetRqs = RQ ? [RQ] : reqIds;

// 골든 케이스가 존재하지 않는 RQ를 가리키면 그 케이스는 어느 분모에도 안 들어간다 —
// 분모를 뒤집기 전과 같은 구멍이 케이스 쪽에서 다시 열리는 것이라 무결성 문제로 잡는다.
for (const c of cases) {
  const spec = String(c.spec || '').toUpperCase();
  if (!spec) {
    integrity.push({
      what: `골든 L${c._line} (${c.id})에 spec 필드가 없다 — 어느 요구사항의 케이스인지 아무도 안 적었다`,
      how: `evals/golden/track-a-product.jsonl의 그 줄에 "spec":"RQ-XX"를 넣어라. spec이 없는 케이스는 어느 RQ의 커버리지에도 기여하지 않는다.`,
    });
  } else if (!reqIds.includes(spec)) {
    integrity.push({
      what: `골든 L${c._line} (${c.id})의 spec이 존재하지 않는 요구사항을 가리킨다: ${spec}`,
      how: `오타이거나 삭제된 RQ다. spec을 실재하는 RQ로 고쳐라 (요구사항: ${reqIds.join(', ')}). 이 케이스는 지금 어느 RQ의 분모에도 들어가지 않는다.`,
    });
  }
}

// ── 케이스 단위 판정 (분모가 바뀌어도 이 검사는 그대로다) ───────────────────
const selectedCases = cases.filter((c) => targetRqs.includes(String(c.spec || '').toUpperCase()));
const results = [];
for (const c of selectedCases) {
  const r = {
    id: c.id,
    spec: String(c.spec).toUpperCase(),
    status: String(c.status || 'todo').toLowerCase(),
    verify: c.verify || null,
    problems: [],
    state: 'covered',
    titles: [],
  };
  if (!r.verify) {
    r.problems.push('verify 필드가 없다 — 어느 테스트가 이 케이스를 지키는지 아무도 안 적었다');
    r.state = 'uncovered';
  } else if (!existsSync(join(ROOT, r.verify))) {
    r.problems.push(`verify 경로가 실재하지 않는다: ${r.verify}`);
    r.state = 'uncovered';
  } else {
    if (!runnable(r.verify)) {
      r.problems.push(`vitest include(${includes.map((i) => i.glob).join(', ')})에 걸리지 않는다 — 파일은 있는데 실행되지 않는다`);
      r.state = 'uncovered';
    }
    const hits = titlesOf(r.verify).filter((t) => t.title.includes(c.id));
    if (hits.length === 0) {
      r.problems.push(`${r.verify} 안에 '${c.id}'를 제목에 담은 describe/it/test가 없다 (주석 언급은 커버가 아니다)`);
      r.state = 'uncovered';
    } else if (!hits.some((t) => t.running)) {
      const why = hits.map((t) => {
        const dead = t.selfRunning ? t.ancestors.find((a) => !a.selfRunning) : null;
        return dead ? `${t.kind}${t.mod}(바깥 ${dead.kind}${dead.mod} 안)` : `${t.kind}${t.mod}`;
      });
      r.problems.push(`'${c.id}' 테스트가 ${[...new Set(why)].join(', ')}로 비활성이다 — 이름만 있고 돌지 않는다`);
      r.state = 'uncovered';
    } else {
      r.titles = hits.filter((t) => t.running).map((t) => `${t.kind}: ${t.title.slice(0, 68)}`);
    }
  }
  // status=done인데 미커버 = 사실과 다른 주장(차단). status=todo 미커버 = 아직 안 만든 것(경고).
  r.blocking = r.state === 'uncovered' && r.status === 'done';
  results.push(r);
}
const casesOf = (rq) => results.filter((r) => r.spec === rq);

// ── RQ 단위 판정: 4분류 ─────────────────────────────────────────────────────
const KIND_LABEL = { golden: 'GA', smoke: '스모크', constraint: '제약', uncovered: '미커버' };
const rqs = targetRqs.map((rq) => {
  const list = casesOf(rq);
  const broken = rqProblems.get(rq) || [];
  const map = mapping[rq];
  // 매핑 주장이 검증에 실패했으면 그 RQ는 커버된 것이 아니다 — 분류를 미커버로 되돌리고
  // 미커버 사유로 그 문제를 그대로 보여준다. "매핑은 있는데 못 믿는다"를 통과로 내면
  // 이 파일이 곧 면제 목록이 된다.
  let kind = 'uncovered';
  if (list.length) kind = 'golden';
  else if (map && broken.length === 0) kind = map.kind;

  const blocking = list.filter((r) => r.blocking).length;
  const uncoveredCases = list.filter((r) => r.state === 'uncovered').length;
  const mark = kind === 'uncovered' ? 'FAIL' : blocking ? 'FAIL' : uncoveredCases ? 'WARN' : 'PASS';
  return { rq, kind, list, map, broken, blocking, uncoveredCases, mark };
});

const nGolden = rqs.filter((r) => r.kind === 'golden').length;
const nSmoke = rqs.filter((r) => r.kind === 'smoke').length;
const nConstraint = rqs.filter((r) => r.kind === 'constraint').length;
const uncoveredRqs = rqs.filter((r) => r.kind === 'uncovered');

// ── 출력 ────────────────────────────────────────────────────────────────────
const coveredCases = results.filter((r) => r.state === 'covered');
const uncoveredCases = results.filter((r) => r.state === 'uncovered');
const blockingCases = results.filter((r) => r.blocking);

console.log(`골든 커버리지 — S3 요구사항 충족${RQ ? ` · ${RQ}` : ''}`);
console.log(`RQ ${rqs.length}건 · GA ${nGolden} · 스모크 ${nSmoke} · 제약 ${nConstraint} · 미커버 ${uncoveredRqs.length}`);
console.log(`GA 케이스 ${results.length}건 · 테스트 커버 ${coveredCases.length} · 미커버 ${uncoveredCases.length} (차단 ${blockingCases.length})`);
console.log(`분모: specs/requirements.md (RQ 전수)${RQ ? ` — 지금은 ${RQ}만 본다` : ''} · vitest include: ${includes.map((i) => i.glob).join(' , ')}`);
console.log('');

for (const r of [...rqs].sort((a, b) => byId(a.rq, b.rq))) {
  let detail;
  if (r.kind === 'golden') {
    const ok = r.list.length - r.uncoveredCases;
    detail = `${pad(`${ok}/${r.list.length}`, 6)}${r.list.map((c) => c.id + (c.state === 'covered' ? '' : ' !')).join(' ')}`;
  } else if (r.kind === 'smoke' || r.kind === 'constraint') {
    detail = `${pad('—', 6)}${r.map.named[0]}`;
  } else {
    detail = `${pad('—', 6)}검증 경로 없음`;
  }
  console.log(`  ${r.mark}  ${pad(r.rq, 7)}${pad(KIND_LABEL[r.kind], 8)}${detail}`);
}
console.log('');

if (mappingMissing) {
  console.log('참고: harness/rq-coverage.json이 없다 — GA 케이스가 없는 RQ를 스모크/제약으로 분류할 근거가 없어');
  console.log('      전부 미커버로 잡힌다. 이 파일이 그 지식이 사는 자리다(지금은 사람 머릿속과 docs/progress.md 산문에만 있다).');
  console.log('');
}
if (reqDupes.length) {
  console.log(`참고: specs/requirements.md에 중복 정의된 RQ가 있다: ${[...new Set(reqDupes)].join(', ')} — 첫 번째만 셌다.`);
  console.log('');
}

// ── 미커버 RQ — 이 센서의 존재 이유 ─────────────────────────────────────────
if (uncoveredRqs.length) {
  console.log('── 미커버 RQ ─────────────────────────────────────────────────────────');
  for (const r of uncoveredRqs) {
    console.log(`FAIL ${r.rq} 가 어디에서도 검증되지 않는다.`);
    if (r.broken.length) {
      // 매핑은 있는데 그 주장이 검증에 실패한 경우 — 일반 안내가 아니라 그 문제를 짚는다.
      for (const b of r.broken) {
        console.log(`     ${b.what}`);
        console.log(`     고치는 법: ${b.how}`);
      }
    } else {
      console.log('     specs/requirements.md에는 있는데 GA 케이스도, 스모크도, ADR 제약 매핑도 없다.');
      console.log('     테스트가 전부 통과해도 이 요구사항은 아무도 확인하지 않았다.');
      console.log('     고치는 법 3가지:');
      console.log('      1) (권장) GA 케이스를 추가한다 → evals/golden/track-a-product.jsonl 에 한 줄:');
      console.log(`         {"id":"GA-XX","spec":"${r.rq}","given":"...","when":"...","then":"...","verify":"tests/integration/...","status":"todo"}`);
      console.log('         (사람 승인 게이트를 거친다 — 골든 정답은 사람이 쓴다)');
      console.log('      2) 배포 아티팩트에서 검증되는 종류라면 → scripts/smoke.sh 에 추가하고');
      console.log(`         harness/rq-coverage.json 의 rq.${r.rq} 를 kind:"smoke" 로 매핑한다`);
      console.log('      3) ADR 의 구조적 제약으로 충족된다면 → harness/rq-coverage.json 의');
      console.log(`         rq.${r.rq} 를 kind:"constraint" 로 매핑하고 근거 ADR 을 refs 에 적는다`);
      console.log('     (2·3은 why와 refs가 필수다. 근거 파일이 실재하고 그 안에서 이 RQ를 언급해야 통과한다.)');
    }
  }
  console.log('');
}

// ── 무결성 — 분모/케이스가 서로를 가리키지 못하는 상태 ──────────────────────
if (integrity.length) {
  console.log('── 매핑·골든 무결성 ──────────────────────────────────────────────────');
  for (const p of integrity) {
    console.log(`${RQ ? 'WARN' : 'FAIL'} ${p.what}`);
    console.log(`     고치는 법: ${p.how}`);
  }
  // --rq 는 전이 가드가 부르는 경로다. 다른 RQ의 무결성 문제로 전이를 막으면 게이트가
  // 무관한 이유로 빨개지고, 그때부터 사람은 force를 배운다(운영 규칙 7).
  if (RQ) console.log('     (--rq 모드에서는 경고다. 전수 실행 `node scripts/golden-coverage.mjs`에서 차단된다.)');
  console.log('');
}

// ── 미커버 GA 케이스 (케이스 단위 — 기존 검사 그대로) ───────────────────────
if (uncoveredCases.length) {
  console.log('── 미커버 GA 케이스 ──────────────────────────────────────────────────');
  for (const r of uncoveredCases) {
    console.log(`${r.blocking ? 'FAIL' : 'WARN'} ${r.id} (${r.spec}, status=${r.status})`);
    for (const p of r.problems) console.log(`     ${p}`);
    console.log(`     고치는 법: ${r.verify || 'tests/integration/<rq>.test.ts'}에 이 케이스의 given/when/then을 그대로 옮긴 테스트를 쓰고,`);
    console.log(`       **제목에 ${r.id}를 넣어라** — 제목이 골든과 코드를 잇는 유일한 기계적 고리다.`);
    console.log(`       예: it('...설명... (${r.spec}, ${r.id})', async () => { ... })`);
    if (!r.blocking) {
      console.log(`       (status="${r.status}"이므로 지금은 경고다. 구현하며 status를 "done"으로 올리면 그때부터 차단된다.)`);
    }
  }
  console.log('');
}

if (SHOW_ORPHANS) {
  const referenced = new Set(cases.map((c) => c.verify).filter(Boolean));
  const orphans = listTestFiles().filter((f) => !referenced.has(f));
  console.log('── 골든에 매이지 않은 테스트 파일 (advisory) ──────────────────────────');
  if (!orphans.length) console.log('  없음 — 모든 테스트 파일이 어떤 골든 케이스의 verify 대상이다.');
  for (const o of orphans) console.log(`  ${o}  ← 어떤 GA-* 케이스도 이 파일을 verify로 지목하지 않는다`);
  console.log('  (나쁘다는 뜻은 아니다 — 스캐폴드·회귀 테스트는 골든 없이 존재할 수 있다.');
  console.log('   다만 "이 테스트가 무슨 사양을 지키는지"를 아무도 안 적었다는 뜻이다.)');
  console.log('');
}

// ── --run: 이름 붙은 테스트가 실제로 실행·통과하는지 ────────────────────────
if (DO_RUN) {
  const cli = join(ROOT, 'node_modules/vitest/vitest.mjs');
  console.log('── --run 실제 실행 대조 ───────────────────────────────────────────────');
  if (!existsSync(cli)) {
    console.log('  node_modules/vitest/vitest.mjs를 찾을 수 없다. `npm ci` 후 다시 시도하라.');
    console.log('  (위 정적 검사 결과는 그대로 유효하다 — 실행은 추가 증거이지 대체가 아니다.)');
  } else {
    const files = [...new Set(results.filter((r) => r.verify && existsSync(join(ROOT, r.verify))).map((r) => r.verify))];
    console.log(`  ${files.length}개 파일 실행 중…`);
    const proc = spawnSync(process.execPath, [cli, 'run', '--reporter=json', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = proc.stdout || '';
    const at = stdout.indexOf('{');
    let report = null;
    if (at >= 0) {
      try {
        report = JSON.parse(stdout.slice(at));
      } catch {
        report = null;
      }
    }
    if (!report) {
      console.log('  vitest JSON 리포트를 파싱하지 못했다 — 실행 자체가 실패했을 수 있다.');
      console.log('  고치는 법: `npx vitest run`을 직접 돌려 출력을 확인하라. 커버리지 판정과는 별개 문제다.');
      process.exitCode = 1;
    } else {
      const ran = [];
      for (const suite of report.testResults || []) {
        for (const a of suite.assertionResults || []) {
          ran.push({ name: [...(a.ancestorTitles || []), a.title || ''].join(' '), status: a.status });
        }
      }
      let miss = 0;
      for (const r of results) {
        if (r.state !== 'covered') continue;
        if (ran.some((x) => x.name.includes(r.id) && x.status === 'passed')) continue;
        miss++;
        const any = ran.find((x) => x.name.includes(r.id));
        console.log(`  FAIL ${r.id} — ${any ? `실행됐지만 상태가 '${any.status}'` : '실행 결과에 나타나지 않았다'}`);
      }
      console.log(`  실행 테스트 ${ran.length}건 · 골든 대조 불일치 ${miss}건`);
      if (miss) {
        console.log('  고치는 법: 제목에 GA-ID는 있으나 통과하지 않았다. 정적 커버는 "테스트가 있다"까지만 증명한다 —');
        console.log('    통과 여부는 S2(테스트 실행)의 관할이고, 여기서는 둘이 어긋났다는 사실만 보고한다.');
        process.exitCode = 1;
      }
    }
  }
  console.log('');
}

// ── 판정 ────────────────────────────────────────────────────────────────────
const verdicts = [];
if (uncoveredRqs.length) verdicts.push(`검증 경로가 없는 RQ ${uncoveredRqs.length}건: ${uncoveredRqs.map((r) => r.rq).join(', ')}`);
if (blockingCases.length) verdicts.push(`status="done"인데 실행되는 테스트가 없는 GA 케이스 ${blockingCases.length}건: ${blockingCases.map((r) => r.id).join(', ')}`);
if (integrity.length && !RQ) verdicts.push(`매핑·골든 무결성 ${integrity.length}건`);

if (verdicts.length) {
  console.log(`실패 — ${verdicts.join(' / ')}`);
  if (uncoveredRqs.length) {
    console.log('분류하지 않고 두면 이 센서는 "27/27 통과" 같은 문장을 계속 만들어낸다 — 분모에 없는 것은 실패하지 않기 때문이다.');
  }
  if (blockingCases.length) {
    console.log('테스트가 전부 통과해도 이건 완료가 아니다. 골든이 "완료"라 적힌 것과 코드가 어긋났다.');
  }
  process.exit(1);
}
console.log(
  `통과 — RQ ${rqs.length}건 전부 검증 경로가 있다 (GA ${nGolden} · 스모크 ${nSmoke} · 제약 ${nConstraint})` +
    `${uncoveredCases.length ? ` · 미구현 status의 미커버 GA 케이스 ${uncoveredCases.length}건은 경고` : ''}.`
);
process.exit(0);
