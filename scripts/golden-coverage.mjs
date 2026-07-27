#!/usr/bin/env node
/**
 * scripts/golden-coverage.mjs — 센서 계열 S3 (요구사항 충족).
 *
 * 질문: "스펙이 시킨 걸 했나?"   기질: evals/golden.
 * **이 계열만 잡는 실패**: 테스트가 전부 초록인데 GA-22에 해당하는 테스트가 **아예 없다**.
 * S2(테스트 실행)로는 원리적으로 관측 불가능하다 — 없는 테스트는 실패하지 않는다.
 * 없는 테스트는 조용하다. 그 침묵을 소리로 바꾸는 것이 이 스크립트의 전부다.
 *
 * "사양 대조 없는 테스트 통과는 완료가 아니다"의 기계적 집행 지점.
 *
 *   node scripts/golden-coverage.mjs              전 케이스
 *   node scripts/golden-coverage.mjs --rq RQ-13   해당 RQ만 (GREEN→EVAL 전이 가드가 이 형태로 부른다)
 *   node scripts/golden-coverage.mjs --run        vitest를 실제로 돌려 "이름 붙은 테스트가 진짜 도는지" 대조
 *   node scripts/golden-coverage.mjs --orphans    골든에 매이지 않은 테스트 파일도 보고
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GOLDEN = join(ROOT, 'evals/golden/track-a-product.jsonl');
const VITEST_CFG = join(ROOT, 'vitest.config.ts');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/golden-coverage.mjs [--rq RQ-XX] [--run] [--orphans]');
  process.exit(0);
}
const RQ = (() => {
  const i = argv.indexOf('--rq');
  return i >= 0 && argv[i + 1] ? argv[i + 1].toUpperCase() : null;
})();
const DO_RUN = argv.includes('--run');
const SHOW_ORPHANS = argv.includes('--orphans');

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

// ── 판정 ────────────────────────────────────────────────────────────────────
const selected = RQ ? cases.filter((c) => String(c.spec || '').toUpperCase() === RQ) : cases;
if (RQ && selected.length === 0) {
  console.error(`골든 셋에 ${RQ}에 매핑된 GA-* 케이스가 없다.`);
  console.error('고치는 법 — 둘 중 하나다:');
  console.error(
    '  1) RQ ID 오타를 고쳐라 (골든에 있는 spec: ' +
      [...new Set(cases.map((c) => c.spec))].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true })).join(', ') +
      ')'
  );
  console.error('  2) 이 RQ의 수용 기준을 골든 케이스로 옮겨 적어라 — track-a-product.jsonl에 한 줄:');
  console.error(`     {"id":"GA-XX","spec":"${RQ}","given":"...","when":"...","then":"...","verify":"tests/integration/...","status":"todo"}`);
  console.error('  골든 0건은 "검증할 게 없다"가 아니라 "무엇을 만족해야 하는지 아무도 안 적었다"는 뜻이다.');
  process.exit(1);
}

const results = [];
for (const c of selected) {
  const r = {
    id: c.id,
    spec: c.spec,
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

// ── 출력 ────────────────────────────────────────────────────────────────────
const covered = results.filter((r) => r.state === 'covered');
const uncovered = results.filter((r) => r.state === 'uncovered');
const blocking = results.filter((r) => r.blocking);

console.log(`골든 커버리지 — S3 요구사항 충족${RQ ? ` · ${RQ}` : ''}`);
console.log(`대상 ${results.length}건 · 커버 ${covered.length} · 미커버 ${uncovered.length} (차단 ${blocking.length})`);
console.log(`vitest include: ${includes.map((i) => i.glob).join(' , ')}`);
console.log('');

const bySpec = new Map();
for (const r of results) {
  if (!bySpec.has(r.spec)) bySpec.set(r.spec, []);
  bySpec.get(r.spec).push(r);
}
for (const spec of [...bySpec.keys()].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))) {
  const list = bySpec.get(spec);
  const ok = list.filter((r) => r.state === 'covered').length;
  console.log(
    `  ${ok === list.length ? 'PASS' : 'FAIL'}  ${String(spec).padEnd(6)} ${`${ok}/${list.length}`.padEnd(6)} ${list
      .map((r) => r.id + (r.state === 'covered' ? '' : ' !'))
      .join(' ')}`
  );
}
console.log('');

if (uncovered.length) {
  console.log('── 미커버 ─────────────────────────────────────────────────────────────');
  for (const r of uncovered) {
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

if (blocking.length) {
  console.log(`실패 — status="done"인데 실행되는 테스트가 없는 골든 케이스 ${blocking.length}건: ${blocking.map((r) => r.id).join(', ')}`);
  console.log('테스트가 전부 통과해도 이건 완료가 아니다. 골든이 "완료"라 적힌 것과 코드가 어긋났다.');
  process.exit(1);
}
console.log(`통과 — ${covered.length}/${results.length} 커버${uncovered.length ? ` · 미구현 status의 미커버 ${uncovered.length}건은 경고` : ''}.`);
process.exit(0);
