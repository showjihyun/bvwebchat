#!/usr/bin/env node
/**
 * scripts/policy-lint.mjs — 정책 파일 린터 겸 README 생성기.
 *
 * 통제면(Plane 2)의 진실 공급원인 harness/policy/*.json 자체를 검사한다.
 * 정책이 틀리면 게이트는 틀린 것을 정확하게 강제한다 — 그래서 정책이 첫 번째 검사 대상이다.
 *
 *   node scripts/policy-lint.mjs           검증. 실패 시 exit 1
 *   node scripts/policy-lint.mjs --print   harness/policy/README.md 생성(사람용 표)
 *
 * README를 손으로 쓰지 않고 생성하는 이유: 표와 정책은 반드시 어긋난다.
 * 생성물이면 어긋날 자리가 없다. 생성 결과에 날짜를 넣지 않는 것도 같은 이유다
 * (재생성마다 diff가 나면 아무도 재생성하지 않는다).
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX = join(ROOT, 'harness/policy/phase-matrix.json');
const RISK = join(ROOT, 'harness/policy/tool-risk.json');
const README = join(ROOT, 'harness/policy/README.md');
const CATALOG = join(ROOT, 'harness/sensor-catalog.md');
const DOC_MAP = join(ROOT, 'harness/doc-map.json');
const SETTINGS = join(ROOT, '.claude/settings.json');

const problems = [];
const notes = [];

/** 문제 1건 = 무엇이 틀렸는가 + 어떻게 고치는가. 후자가 없으면 센서가 아니라 잔소리다. */
function fail(id, what, how) {
  problems.push({ id, what, how });
}
function note(id, what) {
  notes.push({ id, what });
}

/** glob → RegExp. `**`는 경로 구분자를 넘고 `*`는 넘지 않는다. */
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
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** glob이 대표하는 경로 1개를 만든다. deny가 allow를 가리는지 판정하는 데 쓴다. */
function sampleFromGlob(glob) {
  return glob.replace(/\*\*\/?/g, 'x/').replace(/\*/g, 'x').replace(/\/+$/, '');
}

function loadJson(path, label) {
  if (!existsSync(path)) {
    fail(
      'P1',
      `${label} 파일이 없다: ${path.slice(ROOT.length + 1)}`,
      `harness/policy/ 아래에 파일을 만들어라. 이 저장소의 통제면은 이 파일 없이는 존재하지 않는다.`
    );
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(
      'P1',
      `${label} JSON 파싱 실패: ${e.message}`,
      `node -e "JSON.parse(require('fs').readFileSync('${path.slice(ROOT.length + 1)}','utf8'))" 로 위치를 확인하고 고쳐라. 파싱 실패는 게이트 전체의 fail-closed를 뜻한다.`
    );
    return null;
  }
}

// ── P1 스키마 ────────────────────────────────────────────────────────────────
const matrix = loadJson(MATRIX, 'phase-matrix.json');
const risk = loadJson(RISK, 'tool-risk.json');

function checkMatrixSchema(m) {
  for (const key of ['schema', 'enforce', 'phases', 'transitions', 'guards']) {
    if (!(key in m)) {
      fail('P1', `phase-matrix.json에 최상위 키 '${key}'가 없다`, `'${key}'를 추가하라. 5개 키(schema/enforce/phases/transitions/guards)가 이 파일의 최소 계약이다.`);
    }
  }
  if (!m.phases || typeof m.phases !== 'object') return;

  const names = Object.keys(m.phases);
  for (const [name, p] of Object.entries(m.phases)) {
    for (const key of ['purpose', 'write_allow', 'write_deny', 'exit_hint']) {
      if (!(key in p)) {
        fail('P1', `phases.${name}에 '${key}'가 없다`, `phases.${name}에 '${key}'를 추가하라. exit_hint가 없으면 차단당한 에이전트가 나갈 길을 모른다.`);
      }
    }
    if (p.exit_hint !== undefined && !String(p.exit_hint).trim()) {
      fail('P1', `phases.${name}.exit_hint가 비어 있다`, `다음 단계로 가는 실제 명령을 적어라 (예: "python harness/phase.py enter GREEN").`);
    }
  }

  const enf = m.enforce || {};
  if (!['block', 'warn'].includes(enf.default)) {
    fail('P1', `enforce.default가 'block'|'warn'이 아니다: ${JSON.stringify(enf.default)}`, `enforce.default를 "block" 또는 "warn"으로 고쳐라.`);
  }
  for (const ph of enf.warn_only || []) {
    if (!names.includes(ph)) {
      fail('P1', `enforce.warn_only에 없는 단계 '${ph}'가 있다`, `오타이거나 삭제된 단계다. phases에 정의된 단계명(${names.join(', ')}) 중 하나로 고치거나 목록에서 빼라.`);
    }
  }
  if ((enf.warn_only || []).length > 0) {
    note('P1', `enforce: default=${enf.default}, warn_only=[${(enf.warn_only || []).join(', ')}] — 이 단계들은 차단 대신 경고만 낸다`);
  }
}

// ── P2 IDLE 도달성 / P4 전이 그래프 연결성 ──────────────────────────────────
function checkReachability(m) {
  const names = Object.keys(m.phases || {});
  if (!names.length) return;

  const edges = new Map(names.map((n) => [n, new Set()]));
  const wildcardTargets = new Set();

  for (const t of m.transitions || []) {
    const tos = Array.isArray(t.to) ? t.to : [t.to];
    for (const to of tos) {
      if (!names.includes(to)) {
        fail('P1', `transitions에 정의되지 않은 목적지 단계 '${to}'가 있다 (from: ${t.from})`, `phases에 '${to}'를 정의하거나 이 전이를 지워라.`);
        continue;
      }
      if (t.from === '*') {
        wildcardTargets.add(to);
      } else if (!names.includes(t.from)) {
        fail('P1', `transitions에 정의되지 않은 출발 단계 '${t.from}'가 있다`, `phases에 '${t.from}'를 정의하거나 이 전이를 지워라.`);
      } else {
        edges.get(t.from).add(to);
      }
    }
  }
  for (const n of names) for (const to of wildcardTargets) edges.get(n).add(to);

  // P2: IDLE에서 전 단계 도달 가능한가
  const seen = new Set(['IDLE']);
  const queue = ['IDLE'];
  if (!names.includes('IDLE')) {
    fail('P2', `단계 'IDLE'이 정의되지 않았다`, `IDLE은 상태 파일 부재·손상 시의 fail-closed 기본값이다. 반드시 존재해야 한다.`);
    return;
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const to of edges.get(cur) || []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  for (const n of names) {
    if (!seen.has(n)) {
      fail('P2', `단계 '${n}'에 IDLE에서 도달할 수 없다 — 죽은 단계다`, `transitions에 '${n}'로 가는 간선을 추가하라. 도달 불가 단계는 phase.py가 절대 만들 수 없으므로, 그 단계의 write_allow는 영원히 죽은 규칙이다.`);
    }
  }

  // P4: 모든 단계가 IDLE로 되돌아갈 수 있는가 (역방향 도달성 = 그래프 연결)
  const rev = new Map(names.map((n) => [n, new Set()]));
  for (const [from, tos] of edges) for (const to of tos) rev.get(to).add(from);
  const back = new Set(['IDLE']);
  const q2 = ['IDLE'];
  while (q2.length) {
    const cur = q2.shift();
    for (const from of rev.get(cur) || []) {
      if (!back.has(from)) {
        back.add(from);
        q2.push(from);
      }
    }
  }
  for (const n of names) {
    if (!back.has(n)) {
      fail('P4', `단계 '${n}'에서 IDLE로 돌아갈 수 없다 — 흡수 상태(트랩)다`, `'${n}' → IDLE 중단 경로를 추가하라. 나갈 수 없는 단계에 들어간 세션은 상태 파일을 손으로 고치는 수밖에 없고, 그 순간 통제면이 무의미해진다.`);
    }
  }
}

// ── P3 빈 write_allow ────────────────────────────────────────────────────────
function checkWriteAllow(m) {
  for (const [name, p] of Object.entries(m.phases || {})) {
    const allow = p.write_allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      fail('P3', `phases.${name}.write_allow가 비어 있다`, `단계 '${name}'에서는 어떤 파일도 쓸 수 없다는 뜻이다. 의도한 것이면 그 단계는 존재할 이유가 없다. 최소한 "_workspace/**"를 넣어 기록이라도 남길 수 있게 하라.`);
    }
  }
}

// ── P5 가드 참조 무결성 ─────────────────────────────────────────────────────
function checkGuards(m) {
  const defined = new Set(Object.keys(m.guards || {}));
  const referenced = new Set();
  for (const t of m.transitions || []) for (const g of t.guards || []) referenced.add(g);

  for (const g of referenced) {
    if (!defined.has(g)) {
      fail('P5', `전이가 정의되지 않은 가드 '${g}'를 참조한다`, `guards.${g}를 정의하거나 전이에서 이 가드를 빼라. 미정의 가드는 phase.py에서 조용히 통과되거나(가장 나쁨) 크래시한다.`);
    }
  }
  for (const g of defined) {
    if (!referenced.has(g)) {
      note('P5', `가드 '${g}'가 정의만 되고 아무 전이도 쓰지 않는다 — 죽은 가드다 (advisory)`);
    }
  }
  for (const [name, g] of Object.entries(m.guards || {})) {
    if (!g.fail_hint || !String(g.fail_hint).trim()) {
      fail('P5', `guards.${name}에 fail_hint가 없다`, `가드가 막았을 때 "무엇을 어떻게 하면 통과하는지"를 적어라 (센서 카탈로그 운영 규칙 2). 이유 없는 차단은 force 습관으로 이어진다.`);
    }
    if (!g.kind) {
      fail('P5', `guards.${name}에 kind가 없다`, `kind를 지정하라 (grep_count | state_field | git | exec | file_contains).`);
    }
  }
}

// ── P6 deny가 자기 allow를 가림 ──────────────────────────────────────────────
function checkShadowing(m) {
  for (const [name, p] of Object.entries(m.phases || {})) {
    const denies = (p.write_deny || []).map((d) => ({ glob: d, re: globToRegExp(d) }));
    for (const a of p.write_allow || []) {
      const sample = sampleFromGlob(a);
      for (const d of denies) {
        if (d.re.test(sample)) {
          fail(
            'P6',
            `phases.${name}: deny '${d.glob}'가 자기 allow '${a}'를 가린다 (예: ${sample})`,
            `둘 중 하나를 지워라. deny가 allow를 덮으면 그 allow는 문서상으로만 존재하고 실제로는 절대 허용되지 않는다 — 에이전트가 "허용됐다는데 막힌다"를 겪는 순간 게이트 신뢰가 무너진다.`
          );
        }
      }
    }
  }
}

// ── P7 tool-risk 무결성 ─────────────────────────────────────────────────────
function checkRisk(r) {
  const tiers = Object.keys(r.tiers || {});
  if (!tiers.length) {
    fail('P1', `tool-risk.json에 tiers가 없다`, `R0~R3 등급 정의를 추가하라.`);
    return;
  }
  for (const [tier, t] of Object.entries(r.tiers)) {
    for (const key of ['label', 'definition', 'policy', 'enforced_by']) {
      if (!t[key]) fail('P1', `tiers.${tier}에 '${key}'가 없다`, `tiers.${tier}.${key}를 채워라. enforced_by가 없으면 "누가 강제하는가"가 불명확해져 훅과 permissions가 서로 미룬다.`);
    }
  }
  for (const group of ['file_tools', 'bash_prefixes']) {
    for (const tier of Object.keys(r[group] || {})) {
      if (!tiers.includes(tier)) {
        fail('P7', `${group}에 정의되지 않은 등급 '${tier}'가 있다`, `tiers에 '${tier}'를 정의하거나 오타를 고쳐라 (정의된 등급: ${tiers.join(', ')}).`);
      }
    }
  }

  // 같은 접두사가 두 등급에 있으면 판정이 비결정적이 된다
  const seen = new Map();
  for (const [tier, list] of Object.entries(r.bash_prefixes || {})) {
    for (const p of list) {
      if (seen.has(p)) {
        fail('P7', `bash 접두사 '${p}'가 ${seen.get(p)}와 ${tier} 두 등급에 중복 정의됐다`, `한쪽에서 지워라. 중복은 판정 순서에 따라 결과가 달라지는 비결정 게이트를 만든다.`);
      } else {
        seen.set(p, tier);
      }
    }
  }
  // 더 긴(더 구체적인) 접두사가 더 낮은 위험 등급에 있으면 최장일치가 위험을 낮춘다
  const rank = { R0: 0, R1: 1, R2: 2, R3: 3 };
  for (const [a, ta] of seen) {
    for (const [b, tb] of seen) {
      if (a !== b && b.startsWith(a + ' ') && rank[tb] < rank[ta]) {
        fail('P7', `'${b}'(${tb})가 '${a}'(${ta})보다 구체적인데 위험 등급이 더 낮다`, `최장일치 판정에서 '${b}'가 '${a}'의 통제를 무력화한다. '${b}'의 등급을 ${ta} 이상으로 올려라.`);
      }
    }
  }

  const pp = r.protected_paths || {};
  if (!Array.isArray(pp.deny_redirect) || pp.deny_redirect.length === 0) {
    fail('P7', `protected_paths.deny_redirect가 비어 있다`, `최소한 ".harness/state/", "evals/golden/", ".claude/settings.json", "harness/policy/"를 넣어라. 이 목록이 비면 Bash 리다이렉트로 통제면을 통째로 덮어쓸 수 있다.`);
  }
  const decision = (r.unknown_prefix_policy || {}).decision;
  if (!['allow', 'deny', 'ask'].includes(decision)) {
    fail('P7', `unknown_prefix_policy.decision이 allow|deny|ask가 아니다: ${JSON.stringify(decision)}`, `"ask"를 권장한다. "allow"는 미지 명령을 전부 통과시키고, "deny"는 범용 셸을 버려 전용 도구 폭증으로 간다.`);
  }
  if (decision === 'allow') {
    note('P7', `unknown_prefix_policy.decision="allow" — 미지의 셸 명령이 전부 통과한다. 경계면의 가장 큰 구멍이다 (advisory)`);
  }
}


// ── P8 매칭 불가능한 패턴 ────────────────────────────────────────────────────
/**
 * 문법도 배선도 완벽한데 **의미만 죽은** 가드를 잡는다.
 *
 * 실제 사례 (2026-07-27, W2a 발견): no_pending_spec의 패턴이
 *   "^- \\*\\*RQ-[0-9]+\\*\\* .*\\ud83d\\udfe1"
 * 였다. JSON의 \\u는 리터럴 '\u' 두 글자를 낳고, 파이썬 re는 그것을 **짝 없는
 * 서로게이트 2개**로 읽는다. 그런데 파이썬 문자열에서 🟡는 단일 코드포인트 U+1F7E1이라
 * 서로게이트 쌍으로 쪼개지지 않는다 → **어떤 입력에도 매칭되지 않는다.**
 * 가드는 늘 0건을 돌려주고 expect:0과 일치해 **항상 통과**했다.
 * SPEC→PLAN과 PLAN→RED 양쪽에서 스펙 동결이 전혀 강제되지 않고 있었다.
 * gate_spec_freeze.py를 "영구 no-op"이라고 지우고 기능을 이 가드로 흡수했는데,
 * 그 가드가 다른 이유로 똑같이 no-op였다.
 *
 * **반드시 정적 검사여야 한다.** JS 문자열은 UTF-16이라 /\ud83d\udfe1/는 🟡와 실제로
 * 매칭된다 — 정규식을 JS에서 돌려 확인하면 통과하는데 파이썬 가드는 여전히 죽어 있다.
 * 검사가 검사 대상의 언어를 잘못 고르면 검사 자체가 위양성 통과를 만든다.
 * P1~P7이 전부 PASS인 상태에서 이 결함이 살아 있었다는 것이 이 검사의 존재 이유다.
 */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}|\\U0000[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** 문자열 안의 짝 없는 서로게이트 코드 유닛 위치. 쌍을 이룬 것은 정상이므로 건너뛴다. */
function unpairedSurrogates(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else out.push(i);
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(i);
    }
  }
  return out;
}

const RE_ANCHOR_END = '$';
/**
 * 파이썬 re 전용 문법을 JS 정규식으로 옮긴다. **오탐 방지 전용**이다.
 * 정책 패턴을 실행하는 것은 파이썬이므로, JS가 못 읽는다는 사실만으로 실패시키면
 * (?P<name>...) 같은 정당한 파이썬 패턴이 린트에서 죽는다.
 * 정규화 후에도 컴파일되지 않을 때만 "명백한 구문 오류"로 판정한다.
 */
function normalizePythonRegex(pat) {
  return pat
    .replace(/\(\?P</g, '(?<')
    .replace(/\(\?P=(\w+)\)/g, '')
    .replace(/\(\?#[^)]*\)/g, '')
    .replace(/^\(\?[imsxaLu]+\)/, '')
    .replace(/\\A/g, '^')
    .replace(/\\[Zz]/g, () => RE_ANCHOR_END);
}

function checkPatterns(m) {
  for (const [name, g] of Object.entries(m.guards || {})) {
    const pat = g.pattern;
    if (typeof pat !== 'string' || !pat) continue;

    const esc = SURROGATE_ESCAPE.exec(pat);
    if (esc) {
      fail(
        'P8',
        `guards.${name}의 패턴에 서로게이트 이스케이프 '${esc[0]}'가 있다 — 파이썬 re에서 이 패턴은 어떤 입력에도 매칭되지 않는다`,
        `이스케이프를 지우고 **문자를 그대로** 써라 (예: \\ud83d\\udfe1 → 🟡). 파이썬 문자열의 이모지는 단일 코드포인트라 ` +
          `서로게이트 쌍으로 쪼개지지 않는다. 지금 이 가드는 늘 0건을 돌려주고 expect와 일치해 **항상 통과**한다 — ` +
          `즉 게이트가 꺼져 있는데 초록으로 보인다. JS에서 같은 정규식을 돌리면 매칭되므로 실행으로는 확인되지 않는다 — 그래서 이 검사는 패턴을 돌리지 않고 문자열만 본다. (근거: 2026-07-27 no_pending_spec — P1~P7이 전부 초록인 채로 스펙 동결이 두 전이에서 꺼져 있었다)`
      );
    }

    const lone = unpairedSurrogates(pat);
    if (lone.length) {
      fail(
        'P8',
        `guards.${name}의 패턴에 짝 없는 서로게이트 문자가 ${lone.length}개 있다 (위치 ${lone.join(', ')})`,
        `패턴을 UTF-8로 다시 저장하고 해당 문자를 올바른 코드포인트로 써라. 짝 없는 서로게이트는 파이썬과 JS가 다르게 해석해 ` +
          `양쪽에서 다른 판정이 나온다 — 같은 정책 파일이 언어마다 다르게 집행되는 상태다.`
      );
    }

    // ── (2) 컴파일 가능성 — 명백한 구문 오류만 잡는다
    let re = null;
    let compileError = null;
    try {
      re = new RegExp(pat);
    } catch (e1) {
      try {
        re = new RegExp(normalizePythonRegex(pat));
      } catch {
        compileError = e1.message;
      }
    }
    if (compileError) {
      fail(
        'P8',
        `guards.${name}의 패턴이 정규식으로 컴파일되지 않는다 — ${compileError}`,
        `패턴 문법을 고쳐라. 파이썬 방언((?P<name>) 등)은 정규화 후 재시도하므로, 여기까지 온 것은 방언 차이가 아니라 ` +
          `실제 구문 오류다. 컴파일되지 않는 가드는 전이 시점에 예외로 죽거나 조용히 통과한다 — 둘 다 게이트가 없는 것과 같다.`
      );
      continue;
    }

    // ── 부가 신호 (권위 없음): "0건이라 통과"와 "매칭 능력이 없어 통과"를 구별한다
    if (g.expect !== 0 || !g.file || g.file.includes('${')) continue;
    const abs = join(ROOT, g.file);
    if (!existsSync(abs)) {
      note('P8', `guards.${name}의 대상 파일 ${g.file}이 없다 — 판정할 대상 자체가 없다 (advisory)`);
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    if (lines.some((l) => re.test(l))) continue; // 매칭이 있으면 살아 있는 패턴이다

    // 매칭 0건 — 위반이 없어서인가, 노릴 대상이 아예 없어서인가
    const head = pat.split('.*')[0];
    let relaxed = null;
    if (head && head !== pat) {
      try {
        const rre = new RegExp(head);
        relaxed = lines.filter((l) => rre.test(l)).length;
      } catch {
        relaxed = null;
      }
    }
    if (relaxed === 0) {
      note(
        'P8',
        `guards.${name}: 패턴이 0건인데 완화 패턴('${head}')도 0건이다 — '위반이 없다'인지 '검사 대상이 없다'인지 구별되지 않는다 (advisory)`
      );
    }
  }
}

// ── P10 enforced_by 대조 ────────────────────────────────────────────────────
/**
 * tool-risk.json 의 enforced_by 는 **검증되지 않는 주장**이었다. P7 은 이 파일 내부의
 * 일관성만 봤고, policy-lint 는 settings.json 을 한 번도 읽지 않았다.
 *
 * 2026-07-27 실제 사고 (인과를 정확히 적는다 — 이전 서술은 틀렸다):
 * eval-b.mjs·resume-test.mjs 는 R2(경계 이탈)로 분류되고 enforced_by
 * "settings.json ask" 라고 선언돼 있었다. 그런데 `git show 901ebfa:.claude/settings.json`
 * 실측 — **그 시점 ask 목록에 두 항목이 아예 없었다.** 넓은 패턴
 * Bash(node scripts/:*) 가 그 **공백을 덮어** 실행을 통과시켰다.
 *
 * 이전에 이 자리에 "넓은 allow 가 분류를 통째로 삼켰다"고 적었던 것은 사실이
 * 아니고, 다음 사람에게 "P10 이 allow 그림자를 막아준다"고 잘못 가르친다.
 * 실제로 그를 지키는 것은 P10 이 아니라 **deny > ask > allow 우선순위 가정**이다.
 * 즉 명시된 ask 가 있으면 넓은 allow 는 그것을 이기지 못한다 — 그래서 shadow 를
 * 실패로 올리면 오탐이 되고, 이 검사가 실제로 잡는 것은 **분류됐는데 어느
 * 목록에도 없는 항목**이다(사고의 진짜 형태).
 *
 * 분류는 옳았고, 집행이 없었고, 그 사실을 아무 린트도 검사하지 않았다 —
 * no_pending_spec(P8) 과 정확히 같은 형태이고 그때도 P1~P7 은 전부 초록이었다.
 *
 * 판정은 실제 우선순위(deny > ask > allow > 미지=unknown_prefix_policy)로 계산한다.
 * 선언된 등급과 어긋나면: R2/R3 은 보안 구멍이므로 blocking, R0/R1 은 마찰이므로 advisory.
 */
function parseBashEntries(list) {
  const out = [];
  for (const e of list || []) {
    const m = /^Bash\((.*)\)$/.exec(String(e));
    if (!m) continue;
    const body = m[1];
    if (body.endsWith(":*")) out.push({ kind: "prefix", value: body.slice(0, -2) });
    else out.push({ kind: "exact", value: body });
  }
  return out;
}

/** 이 등급 접두사로 시작하는 명령 전체를 이 엔트리가 덮는가. */
function covers(entry, prefix) {
  if (entry.kind === "exact") return entry.value === prefix;
  return prefix.startsWith(entry.value);
}

function checkEnforcement(r) {
  if (!existsSync(SETTINGS)) {
    fail('P10', '.claude/settings.json 이 없다 — tool-risk.json 의 enforced_by 를 대조할 수 없다', 'settings.json 을 만들어라. 등급 분류는 집행되지 않으면 문서일 뿐이다.');
    return;
  }
  let s;
  try {
    s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    fail('P10', '.claude/settings.json 파싱 실패: ' + e.message, 'JSON 문법을 고쳐라. 이 파일이 깨지면 permissions 가 통째로 적용되지 않는다.');
    return;
  }
  const perm = s.permissions || {};
  const groups = {
    deny: parseBashEntries(perm.deny),
    ask: parseBashEntries(perm.ask),
    allow: parseBashEntries(perm.allow),
  };
  const unknown = ((r.unknown_prefix_policy || {}).decision) || "ask";
  const expected = { R0: "allow", R1: "allow", R2: "ask", R3: "deny" };
  const why = {
    R0: "관찰 전용이라 전 단계 허용이어야 한다",
    R1: "gate_phase.py 가 단계×경로로 판정해야 하므로 도구 자체는 허용이어야 한다",
    R2: "비가역·외부 노출이라 사람이 보는 앞에서 실행돼야 한다",
    R3: "이력 파괴·비밀 노출·통제면 훼손이라 프롬프트 없이 거부돼야 한다",
  };

  const missing = new Map();
  for (const [tier, prefixes] of Object.entries(r.bash_prefixes || {})) {
    const want = expected[tier];
    if (!want) continue;
    for (const pre of prefixes) {
      const hit = { deny: groups.deny.find((e) => covers(e, pre)), ask: groups.ask.find((e) => covers(e, pre)), allow: groups.allow.find((e) => covers(e, pre)) };
      const effective = hit.deny ? "deny" : hit.ask ? "ask" : hit.allow ? "allow" : unknown;
      if (effective === want) continue;

      const shadow = hit.allow && (want === "ask" || want === "deny");
      const detail =
        effective === unknown && !hit.deny && !hit.ask && !hit.allow
          ? "settings.json 의 어느 목록에도 없다 → 미지 접두사 정책(" + unknown + ")이 적용된다"
          : "settings.json 이 " + effective + " 로 판정한다" + (shadow ? " — allow 패턴 Bash(" + hit.allow.value + (hit.allow.kind === "prefix" ? ":*" : "") + ") 가 이 접두사를 삼킨다" : "");

      const how =
        want === "deny"
          ? "settings.json 의 deny 에 Bash(" + pre + ":*) 를 추가하라. R3 는 프롬프트 없이 거부돼야 한다."
          : want === "ask"
            ? "settings.json 의 ask 에 Bash(" + pre + ":*) 를 추가하고, 이 접두사를 삼키는 더 넓은 allow 패턴이 있으면 좁혀라. " +
              "2026-07-27 에 정확히 이 형태로 eval-b.mjs 가 승인 없이 실행돼 node_modules 를 파괴했다 — enforced_by 를 보장으로 믿은 것이 그 사고의 전제였다."
            : "settings.json 의 allow 에 Bash(" + pre + ":*) 를 추가하라. 관찰·로컬 변경까지 매번 물으면 프롬프트 피로가 쌓이고, " +
              "그러면 사람이 내용을 안 보고 승인하기 시작한다 — 그 순간 ask 는 allow 와 같아진다.";

      const msg = tier + " " + JSON.stringify(pre) + " 의 선언된 집행은 " + want + " 인데 " + detail + " (" + why[tier] + ")";
      if (tier === "R2" || tier === "R3") fail("P10", msg, how);
      else {
        if (!missing.has(tier)) missing.set(tier, { list: [], how, effective });
        missing.get(tier).list.push(pre);
      }
    }
  }

  for (const [tier, g] of missing) {
    note(
      "P10",
      tier + " 접두사 " + g.list.length + "개가 settings.json 에 없어 " + g.effective + " 로 판정된다: " +
        g.list.join(", ") +
        " — 관찰·로컬 변경까지 매번 물으면 프롬프트 피로가 쌓이고, 그러면 사람이 내용을 안 보고 승인하기 시작한다. " +
        "그 순간 ask 는 allow 와 같아진다 (advisory)"
    );
  }

  const lim = (r._limitation || "").trim();
  note(
    "P10",
    "한계 2가지: (1) 이 검사는 **도구 표면 안에서의 일관성**만 본다. 스크립트가 spawnSync 로 같은 명령을 부르면 등급을 조회하지 않으므로 P10 이 통과해도 그 층의 구멍은 남는다. (2) 판정이 **deny > ask > allow 우선순위를 가정**한다 — 명시된 ask 가 있으면 넓은 allow 가 그것을 이기지 못한다는 전제다. **그 가정 자체는 이 저장소에서 실증되지 않았다**(hooks-selftest 는 gate_phase.py 를 재지 settings.json 우선순위를 재지 않는다). 가정이 틀리면 P10 이 초록인 채로 집행이 없을 수 있다 — 운영 규칙 8의 '선언된 집행이 실제로 일어나는지 아무도 확인하지 않았다'가 한 층 위로 옮겨간 형태다" +
      (lim ? " (tool-risk.json _limitation 참조)" : "")
  );
}

// ── P9 생성물 동기화 ────────────────────────────────────────────────────────
/**
 * README.md는 생성물이고 "손으로 고치지 않는다"고 못 박혀 있다. 그래서 아무도 다시 안 본다 —
 * 정책 JSON만 커밋하고 재생성을 빠뜨리면 **표와 정책이 조용히 어긋난 채로 남는다.**
 * 표를 생성물로 만든 이유가 어긋날 자리를 없애는 것이었는데, 재생성을 강제하지 않으면
 * 그 자리가 "재생성을 잊는 것"으로 옮겨갈 뿐이다.
 *
 * 기계적으로 판정 가능하고(렌더 결과와 파일 비교) 고치는 법이 명령 하나이므로 blocking이다.
 * --print 모드에서는 스스로 재생성하므로 이 검사를 돌리지 않는다.
 */
// ── P11 반복 실패 대장 ─────────────────────────────────────────────────────
/**
 * 운영 규칙 3은 "같은 실수 2회 반복 시 센서 하나 또는 Guide 한 줄"을 요구하는데
 * **누적을 세는 자리가 없었다.** 그래서 2026-07-27 하루에 같은 원인으로 3~9회를
 * 반복하면서 매번 새로 발견했다 — 규칙은 알고 있었고 세는 곳이 없었다.
 *
 * harness/recurrence.md 가 그 자리이고 이 검사가 그것을 문다:
 * **3회 이상인데 처방이 없으면 차단.** 처방을 적는 것이 해소 조건이지
 * 횟수가 줄기를 기다리는 것이 아니다.
 *
 * 이 검사가 policy-lint 에 있는 이유: metrics.mjs 는 의도적으로 항상 exit 0 이다
 * ("지표 산출은 관측이지 판정이 아니다"). 관측과 차단은 다른 도구의 일이다.
 */
/** 규칙 3이 처방을 요구하는 지점. 등재(2회)·차단(2회)·규칙(2회)이 같아야 한다. */
const RECURRENCE_THRESHOLD = 2;

/**
 * 상태 칸의 **닫힌 어휘**. 이 둘 중 어느 쪽에도 안 맞으면 통과가 아니라 판정 불가다.
 * 어휘를 늘리려면 `harness/recurrence.md` 의 `쓰는 법`도 같은 커밋에서 고쳐라 —
 * 두 곳이 어긋나면 대장을 쓰는 사람이 게이트가 무엇을 받는지 알 수 없다.
 */
const RECURRENCE_OPEN_WORDS = ['미처방', '처방 실패', '미정', '미결', '관찰 중'];
const RECURRENCE_CLOSED_WORDS = ['✅', '처방됨', '재처방됨', '완료'];
const RECURRENCE_OPEN = new RegExp(RECURRENCE_OPEN_WORDS.join('|'));
const RECURRENCE_CLOSED = new Set(RECURRENCE_CLOSED_WORDS);

/**
 * 상태 칸 → 판정용 **첫 토큰**. 부분일치를 버린 이유가 전부 여기 있다.
 *
 * `/(✅|처방됨|완료)/.test(s)` 는 **`미완료` 를 닫힘으로 읽는다** — `미완료` 안에
 * `완료` 가 들어 있기 때문이다. 5차 재리뷰가 `미완료`·`처방 미완료`·`완료되지 않음`·
 * `완료 예정`·`처방됨 아님`·`~~처방됨~~` 여섯으로 뚫었고 전부 exit 0 이었다.
 * **이건 "판정 불가"보다 한 칸 더 나쁘다** — 게이트가 모르는 값을 통과시키는 것이
 * 아니라 **"미완료"를 "완료"로 읽는** 역방향 판정이다.
 *
 * 그래서 꾸밈(이모지·기호)과 괄호 주석을 걷어낸 뒤 **첫 토큰만** 집합과 정확 비교한다.
 * 대장의 실제 값 `⚠️ 처방됨, 사각지대 확인 (2026-07-28)` · `✅ 재처방됨 (…, 2차)` 는
 * 첫 토큰이 각각 `처방됨`·`✅` 라 통과하고, `미완료` 는 첫 토큰이 `미완료` 라 막힌다.
 */
function recurrenceStatusToken(status) {
  const s = String(status)
    .replace(/\(.*?\)/g, ' ')                 // 괄호 주석
    .replace(/[^\p{L}\p{N}✅]/gu, ' ')         // 이모지·기호·구두점·취소선
    .trim();
  return s.split(/\s+/).filter(Boolean)[0] || '';
}

/**
 * 부정·미래·취소 표지. **첫 토큰 검사만으로는 부족하다** — 자기시험이 그것을 잡았다:
 * `완료 예정` 은 첫 토큰이 `완료`, `❌ 처방됨 아님` 은 첫 토큰이 `처방됨` 이라
 * 둘 다 닫힘으로 읽혔다. 5차 재리뷰의 처방(첫 토큰 정확 일치)도 이 둘은 못 막는다.
 *
 * 상태 칸이 자유 서술인 한 **뒤에 붙는 한 단어가 앞을 뒤집을 수 있다.** 그래서
 * 첫 토큰이 닫힘이어도 이 표지가 어디든 있으면 판정 불가로 돌린다 — 뒤집힌 판정보다
 * 판정 불가가 낫다.
 */
const RECURRENCE_NEGATION = /아님|아니|않|못|예정|취소|보류|~~|❌|❓|\?/u;

/** 셀 안의 `\|` 를 구분자로 읽지 않는다. 이 저장소의 표는 실제로 `\|\|` 를 쓴다. */
function splitRow(line) {
  return line.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * 대장 텍스트 → 판정. **순수 함수다** — 파일을 읽지 않으므로 합성 케이스로 시험할 수 있다.
 * 반환 `problems` 가 비어 있지 않으면 P11 은 실패한다. 통과 경로는 하나뿐이다:
 * 표를 파싱했고, 모든 행이 형식에 맞고, 임계 이상인 열린 항목이 없다.
 */
export function judgeRecurrence(text) {
  const problems = [];
  const lines = text.split('\n');

  // `## 대장` 절이 있는데 행이 0이면 **파싱 실패**다. "반복이 없다"와 구별한다.
  // 절 **범위**를 실제로 좁힌다. 이전에는 `hasSection` 이 존재만 보고 행 스캔은
  // 파일 전체를 훑어, **같은 파일의 다른 표**가 대장 행으로 읽혔다(4차 리뷰 m-c).
  // 상세 절에 표를 하나 더 넣자마자 P11 이 그 표의 헤더를 손상된 행으로 판정했다.
  const sectionStart = lines.findIndex((l) => /^##\s*대장\s*$/.test(l));
  if (sectionStart < 0) {
    problems.push('`## 대장` 절이 없다 — 대장 형식이 깨졌거나 다른 파일이다');
    return { problems, rows: [], open: [] };
  }
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { sectionEnd = i; break; }
  }
  const headerIdx = lines.findIndex(
    (l, i) => i > sectionStart && i < sectionEnd && /^\|\s*ID\s*\|/.test(l));
  if (headerIdx < 0) {
    problems.push('`## 대장` 절 안에서 `| ID | …` 헤더 행을 찾지 못했다 — 표 파싱 실패');
    return { problems, rows: [], open: [] };
  }
  const width = splitRow(lines[headerIdx]).length;

  const rows = [];
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; // 구분선
    const cells = splitRow(l);
    // 파이프로 시작하는 표 행인데 ID 형식이 아니면 **조용히 넘기지 않는다.**
    // T3(행 접두사 손상)이 여기서 잡힌다 — 손상된 행은 필터가 아니라 실패다.
    if (!/^R\d+$/.test(cells[1] ?? '')) {
      problems.push(`${i + 1}행: ID 칸이 \`R<숫자>\` 가 아니다 (\`${(cells[1] ?? '').slice(0, 20)}\`) — 행이 손상됐다`);
      continue;
    }
    if (cells.length !== width) {
      problems.push(
        `${cells[1]}: 칸이 ${cells.length}개 — 헤더는 ${width}개다. ` +
        '셀 안의 파이프는 `\\|` 로 이스케이프하라. 칸이 밀리면 상태가 엉뚱한 칸에서 읽힌다'
      );
      continue;
    }
    rows.push(cells);
  }
  if (!rows.length) {
    problems.push('`## 대장` 절은 있는데 읽을 수 있는 행이 0개다 — 표 파싱 실패이지 "반복 없음"이 아니다');
    return { problems, rows, open: [] };
  }

  const open = [];
  for (const c of rows) {
    const [, id, cause, countRaw, , cure, status] = c;
    // `|| 0` 으로 삼키지 않는다 — 횟수를 못 읽으면 임계를 못 넘어 **조용히 통과**한다.
    const n = Number(String(countRaw).replace(/\*|\s/g, ''));
    if (!Number.isInteger(n) || n < 1) {
      problems.push(`${id}: 횟수 칸을 양의 정수로 읽을 수 없다 (\`${String(countRaw).slice(0, 20)}\`)`);
      continue;
    }
    // 판정 축은 **허용 목록**이다. 거부 목록이면 목록 밖의 값이 전부 "처방됨"으로
    // 읽힌다 — `보류`·`TBD` 는 억지 입력이 아니라 연기할 때 가장 자연스러운 말이고,
    // **빈 칸은 적대적 입력조차 아니다**(행을 반쯤 채우다 만 가장 흔한 형상).
    // 4차 재리뷰가 A4·A5·A6 으로 셋 다 뚫었고 셋 다 exit 0 이었다.
    // "판정할 수 없는 가드는 없는 가드다"(2026-07-27 결정) — 인식되지 않는 상태는
    // 통과가 아니라 **판정 불가**다.
    const cell = `${cure} ${status}`.trim();
    if (!cell) {
      problems.push(`${id}: 처방·상태 칸이 비어 있다 — 판정할 수 없다`);
    } else if (RECURRENCE_OPEN.test(cell)) {
      if (n >= RECURRENCE_THRESHOLD) open.push(`${id}(${n}회) ${String(cause).replace(/\*/g, '').slice(0, 60)}`);
    } else if (!RECURRENCE_CLOSED.has(recurrenceStatusToken(status))
               || RECURRENCE_NEGATION.test(String(status))) {
      problems.push(
        `${id}: 상태 "${String(status).trim().slice(0, 24)}" 를 판정할 수 없다 ` +
        `(첫 토큰 "${recurrenceStatusToken(status) || '없음'}") — ` +
        `닫힌 어휘(${RECURRENCE_CLOSED_WORDS.join(' · ')})나 열린 어휘(${RECURRENCE_OPEN_WORDS.join(' · ')})를 쓰라. ` +
        `**첫 토큰 정확 일치**로 검사하므로 "미완료"·"완료 예정" 처럼 닫힌 단어를 품은 부정형·미래형은 막힌다`
      );
    }
  }
  return { problems, rows, open };
}

function checkRecurrence() {
  const p = join(ROOT, 'harness/recurrence.md');
  if (!existsSync(p)) {
    fail('P11', 'harness/recurrence.md 가 없다 — 반복 실패를 세는 자리가 없다',
      '만들어라. 누적이 없으면 같은 원인의 2회째를 매번 "새 발견"으로 처리하게 된다.');
    return;
  }
  const { problems, rows, open } = judgeRecurrence(readFileSync(p, 'utf8'));
  if (problems.length) {
    fail('P11',
      `반복 대장을 판정할 수 없다 — ${problems.length}건:\n       ` + problems.join('\n       '),
      'harness/recurrence.md 의 표 형식을 고쳐라. **판정할 수 없는 가드는 없는 가드다**' +
      '(2026-07-27 결정, no_pending_spec 패턴 사망 사건) — 파싱 실패를 통과로 처리하면 ' +
      '대장이 비어도 초록이 뜬다. 형식 시험: node scripts/policy-lint.mjs --self-test');
    return;
  }
  if (open.length) {
    fail('P11',
      `반복 실패 ${open.length}건이 ${RECURRENCE_THRESHOLD}회 이상인데 처방이 열려 있다:\n       ` + open.join('\n       '),
      `harness/recurrence.md 에서 각 항목의 처방을 확정하라 — 규칙 3에 따라 구조/게이트/센서/Guide 중 **하나만** 고르고 근거를 적는다. ` +
      '상태가 "처방 실패"면 그 처방이 실제로 안 먹혔다는 뜻이므로 다시 골라야 한다(마지막 발생이 처방 날짜 이후로 갱신됐는지 보라). ' +
      `횟수가 줄기를 기다리는 것은 해소가 아니다 — ${RECURRENCE_THRESHOLD}회를 넘긴 원인은 다음에도 온다.`);
  } else {
    note('P11', `반복 대장 ${rows.length}건 — ${RECURRENCE_THRESHOLD}회 이상 미처방 0건`);
  }
}

/**
 * P11 음성 시험 — **가드가 잡아야 하는 것을 실제로 잡는지** 합성 케이스로 고정한다.
 * 3차 재리뷰가 T2~T5 로 이 파서를 뚫었다(셀 안 파이프·행 접두사 손상·행 전체 삭제·
 * 횟수 한글 표기). 네 경우 모두 **exit 0** 이었고 같은 실행이 "6건 검사됨"을 찍어
 * 읽는 사람이 검사됐다고 믿게 했다. 그 네 개가 아래 고정 케이스다.
 */
function selfTest() {
  const H = '# 반복 실패 대장\n\n## 대장\n\n| ID | 원인 | 횟수 | 마지막 발생 | 처방 | 상태 |\n|---|---|---|---|---|---|\n';
  const ok = `${H}| R1 | 어떤 원인 | **9** | 2026-07-27 | \`Guide\` — 처방함 | ✅ 처방됨 |\n`;
  const cases = [
    ['T0 정상',                 ok,                                                              false],
    ['T1 상태 미처방',          ok.replace('✅ 처방됨', '미처방'),                                true],
    ['T2 셀 안 파이프',         `${H}| R1 | 원인에 | 가 있다 | **9** | 2026-07-27 | \`Guide\` | 미처방 |\n`, true],
    ['T3 행 접두사 손상',       ok.replace('| R1 |', '|R_1 |'),                                   true],
    ['T4 표 행 전부 삭제',      H,                                                                true],
    ['T5 횟수 한글',            ok.replace('**9**', '아홉').replace('✅ 처방됨', '미처방'),        true],
    ['T6 이스케이프한 파이프',  `${H}| R1 | \\| 를 쓴 원인 | **9** | 2026-07-27 | \`Guide\` — 처방함 | ✅ 처방됨 |\n`, false],
    ['T7 2회 미처방(임계)',     ok.replace('**9**', '2').replace('✅ 처방됨', '🔄 관찰 중'),      true],
    // A4·A5·A6 — 4차 재리뷰가 뚫은 **판정 축**. 파싱은 성공하는데 상태 어휘가
    // 거부 목록 밖이라 조용히 통과했다. A6(빈 칸)이 가장 흔한 형상이다.
    ['A4 상태 "보류"',          ok.replace('`Guide` — 처방함', '보류').replace('✅ 처방됨', '⏸ 보류'), true],
    ['A5 상태 "TBD"',           ok.replace('`Guide` — 처방함', 'TBD').replace('✅ 처방됨', 'TBD'),      true],
    ['A6 처방·상태 빈 칸',      ok.replace('`Guide` — 처방함', ' ').replace('✅ 처방됨', ' '),          true],
    // D1·D4·D6 — 5차 재리뷰가 뚫은 **부분일치**. `미완료` 안에 `완료` 가 있어
    // 닫힘으로 읽혔다. 모르는 값을 통과시키는 것(A4~A6)보다 한 칸 더 나쁘다 —
    // 게이트가 "미완료"를 "완료"로 **읽는다**.
    ['D1 상태 "미완료"',        ok.replace('`Guide` — 처방함', '아직 없다').replace('✅ 처방됨', '미완료'),     true],
    ['D4 상태 "완료 예정"',     ok.replace('`Guide` — 처방함', '아직 없다').replace('✅ 처방됨', '완료 예정'),  true],
    ['D6 상태 "처방됨 아님"',   ok.replace('`Guide` — 처방함', '아직 없다').replace('✅ 처방됨', '❌ 처방됨 아님'), true],
    // 대장의 실제 값 두 형태는 통과해야 한다 — 꾸밈·괄호 주석이 붙어 있다.
    ['D11 실제값 ⚠️+괄호',      ok.replace('✅ 처방됨', '⚠️ 처방됨, 사각지대 확인 (2026-07-28)'),            false],
    ['D12 실제값 재처방됨',     ok.replace('✅ 처방됨', '✅ 재처방됨 (2026-07-28, 2차)'),                     false],
    // 절 범위 — 같은 파일의 **다른 표**가 대장 행으로 읽히면 안 된다(4차 m-c).
    // 상세 절에 표를 하나 넣자마자 실제로 차단이 났다.
    ['E1 상세 절의 다른 표',
      `${ok}\n## R2 상세\n\n| 회차 | 무엇이 | 왜 |\n|---|---|---|\n| 4차 | 판정 축 | 형식만 봤다 |\n`, false],
    ['E2 대장 절이 비어 있음',
      `${H}\n## R1 상세\n\n| ID | 원인 | 횟수 | 마지막 | 처방 | 상태 |\n|---|---|---|---|---|---|\n| R1 | x | **9** | d | c | ✅ |\n`, true],
  ];
  let bad = 0;
  for (const [name, text, mustFail] of cases) {
    const { problems, open } = judgeRecurrence(text);
    const didFail = problems.length > 0 || open.length > 0;
    const pass = didFail === mustFail;
    if (!pass) bad++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} 기대 ${mustFail ? '차단' : '통과'} · 실측 ${didFail ? '차단' : '통과'}` +
      (didFail ? `  (${[...problems, ...open][0]?.slice(0, 70)})` : ''));
  }
  // P9 — 줄바꿈 정규화. **통과값 + 부정어** 짝을 넣는다(`recurrence.md` R2):
  // 'CRLF 만 다르다'(통과)와 '내용도 다르다'(차단)를 함께 두지 않으면, 정규화가
  // 실제 드리프트까지 지워버리는 것을 이 시험이 못 본다.
  const eolCases = [
    ['E3 완전히 같다',        'a\nb\n',        'a\nb\n',        false],
    ['E4 CRLF 만 다르다',     'a\r\nb\r\n',    'a\nb\n',        false],
    ['E5 내용이 다르다',      'a\r\nc\r\n',    'a\nb\n',        true],
    ['E6 줄 하나가 빠졌다',   'a\r\n',         'a\nb\n',        true],
    ['E7 CR 단독은 다르다',   'a\rb\r',        'a\nb\n',        true],
    ['E8 끝 개행 유무',       'a\r\nb',        'a\nb\n',        true],
  ];
  for (const [name, disk, rendered, mustFail] of eolCases) {
    const didFail = !sameIgnoringEol(disk, rendered);
    const pass = didFail === mustFail;
    if (!pass) bad++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} 기대 ${mustFail ? '차단' : '통과'} · 실측 ${didFail ? '차단' : '통과'}`);
  }

  // P12 — 저장소 밖 라벨. **거짓 양성이 이 검사의 진짜 위험이다**: 7차 재리뷰가
  // 앵커(파일명·규칙 ID)를 지운 것이 GB-06 을 3/5 까지 떨어뜨렸음을 실측했다.
  // 그래서 통과 쪽 케이스를 차단 쪽보다 많이 둔다 — 넓게 잡는 게이트는 규칙을 뒤집는다.
  const labelCases = [
    ['리뷰 라벨 M-1',        ['M-1: 기준축을 고정한다'],                                  1],
    ['소문자 m-2',           ['m-2 정렬을 고친다'],                                       1],
    ['알파벳 꼬리 B-j',      ['B-j 처방을 이행한다'],                                     1],
    ['회차 라벨 N9-2',       ['N9-2 를 반영한다'],                                        1],
    ['괄호 안 (B-1)',        ['재리뷰 지적 (B-1) 을 닫는다'],                             1],
    ['한 줄에 둘',           ['M-1 과 M-3 을 함께'],                                      2],
    ['RQ-10 은 통과',        ['RQ-10 의 폴백 경로를 확인한다'],                           0],
    ['GB-06 은 통과',        ['GB-06 재개 시험을 다시 채점한다'],                         0],
    ['ADR-0005 는 통과',     ['ADR-0005 결정3 을 갱신한다'],                              0],
    ['R12·P11 은 통과',      ['recurrence.md R12 와 policy-lint P11 을 본다'],            0],
    ['파일명·경로는 통과',   ['scripts/eval-b.mjs 의 verify-artifact 를 고친다'],         0],
    ['하이픈 단어는 통과',   ['fail-open 을 막고 auto-1 같은 이름은 그대로 둔다'],        0],
    ['숫자 시작은 통과',     ['3-1 절의 표를 갱신한다'],                                  0],
    ['빈 목록',              [],                                                          0],
    ['null 항목',            [null, undefined, ''],                                       0],
    // 2차(2026-08-02 재리뷰 N-2) — 1차는 라벨의 **모양**만 좁힌 게 아니라 **감싸는
    // 문자**까지 좁혀, 이 저장소의 지배적 표기(백틱·중점·조사)가 통째로 샜다.
    // 재리뷰가 커밋된 체크포인트 전수에 돌려 실측한 놓침을 그대로 케이스로 박는다.
    ['백틱 감싼 `M-1`',      ['`M-1` 을 조치했다'],                                       1],
    ['볼드 **M-1**',         ['**M-1** 과 **M-3** 을 닫는다'],                            2],
    ['중점 나열 M-1·M-3',    ['M-1·M-3 정렬을 맞춘다'],                                   2],
    ['슬래시 B-e/B-f',       ['4차 재리뷰 blocker B-e/B-f 조치분'],                       2],
    ['조사 붙은 M-1의',      ['M-1의 기준축을 아티팩트로 고정한다'],                      1],
    ['reviewer 어휘 major-1', ['major-1: useChat.ts 의 센티널을 고친다'],                  1],
    ['여는 괄호 major-1(',   ['major-1(빈 문자열 센티널) 을 먼저'],                       1],
    ['두 자리 꼬리 M-10',    ['M-10 을 확인한다'],                                        1],
    // ↓ 넓힌 뒤에도 통과해야 하는 것 — 조사·괄호가 붙은 정당한 식별자 (R2: 통과값+부정어 짝)
    ['조사 붙은 RQ-10을',    ['RQ-10을 고치고 GB-06을 다시 채점한다'],                    0],
    ['조사 붙은 ADR-0005의', ['ADR-0005의 근거와 R12를 함께 본다'],                       0],
    ['괄호 붙은 RQ-10(',     ['RQ-10(닉네임 유지) 과 GB-06[필수] 를 본다'],               0],
    ['하이픈 단어+조사',     ['fail-open을 막고 x-axis(축) 정렬을 유지한다'],             0],
    ['접미사 RQ-10-a',       ['RQ-10-a 새로고침 경로를 재확인한다'],                      0],
  ];
  for (const [name, items, want] of labelCases) {
    const got = judgeOutsideLabels(items).length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} 기대 ${want ? `차단 ${want}건` : '통과'} · 실측 ${got ? `차단 ${got}건` : '통과'}`);
  }

  // P13 — 가드 커버리지. **차단 쪽에 `통과값 + 부정어` 를 반드시 넣는다**: 이 저장소의
  // 우회는 두 번 다 그 형상이었다(`미완료` = `완료` + 부정 접두 · `완료 예정` = `완료` + 미래).
  // 통과해야 할 값만 시험하면 이 계열은 영원히 안 잡힌다.
  console.log('');
  console.log('── P13 가드 커버리지 (순수 함수 judgeGuardCoverage) ──');
  const coverCases = [
    ['정상 언급',        ['tree_clean'], '`tree_clean` 가드가 미커밋 변경을 막는다', 0],
    ['부정어 — 아직 없다', ['tree_clean'], '`tree_clean` 은 아직 카탈로그에 없다',        1],
    ['부정어 — 누락',     ['tree_clean'], '`tree_clean` 행이 누락돼 있다',              1],
    ['미래형 — 예정',     ['tree_clean'], '`tree_clean` 을 곧 등재할 예정',             1],
    ['미래형 — 추가할',    ['tree_clean'], '`tree_clean` 을 추가할 것',                 1],
    ['부분 문자열 오탐',   ['tree_clean'], '`tree_cleanup` 스크립트가 임시 파일을 지운다',  1],
    ['접두 오탐',        ['red_evidence'], 'pre_red_evidence 라는 다른 이름',           1],
    ['코드 펜스 안은 제외', ['tree_clean'], '```\n tree_clean \n```\n다른 문장',          1],
    ['여러 개 중 하나 누락', ['tree_clean', 'tests_committed'], '`tree_clean` 은 등재됨',  1],
    ['둘 다 등재',       ['tree_clean', 'tests_committed'],
      '`tree_clean` 을 막는다\n`tests_committed` 는 커밋을 요구한다',                    0],
    ['다음 줄 부정어는 무관', ['tree_clean'],
      '`tree_clean` 가드가 막는다\n다른 줄: 아직 없는 것도 있다',                        0],
    ['같은 줄 먼 부정어는 무관', ['tree_clean'],
      '`tree_clean` 가드가 미커밋 변경을 막는다 — 이것이 없으면 증거의 출처가 흐려진다',  0],
    ['가드 0개',        [], '아무 내용',                                             0],
  ];
  for (const [name, guards, text, want] of coverCases) {
    const got = judgeGuardCoverage(guards, text).length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} 기대 ${want ? `누락 ${want}건` : '통과'} · 실측 ${got ? `누락 ${got}건` : '통과'}`);
  }

  // P14 — 문서 관할. **차단 쪽에 `통과값 + 부정어` 형태를 넣는다**: 여기서 그 형상은
  // *"허용 패턴의 접두를 그대로 가지면서 경계만 어긋난 경로"* 다. 통과해야 할 값만
  // 시험하면 `docs/harness/**` 가 `docs/harness-notes.md` 를 삼키는 것을 못 잡는다.
  console.log('');
  console.log('── P14 문서 관할 (순수 함수 judgeDocJurisdiction) ──');
  const P = (allow, deny) => ({ X: { write_allow: allow, ...(deny ? { write_deny: deny } : {}) } });
  const jurCases = [
    ['정상 — 정확 일치',    ['docs/progress.md'], P(['docs/progress.md']),               0],
    ['허용 없음',          ['README.md'],        P(['src/**']),                          1],
    ['/** 하위',          ['docs/harness/x.md'], P(['docs/harness/**']),                 0],
    ['/** 깊은 하위',      ['docs/harness/a/b.md'], P(['docs/harness/**']),              0],
    ['접두는 같고 경계 다름', ['docs/harness-notes.md'], P(['docs/harness/**']),           1],
    ['* 는 / 를 안 넘는다', ['docs/adr/sub/x.md'], P(['docs/adr/*.md']),                  1],
    ['* 같은 깊이',        ['docs/adr/0001.md'], P(['docs/adr/*.md']),                    0],
    ['deny 가 allow 를 덮음', ['specs/requirements.md'], P(['specs/**'], ['specs/**']),   1],
    ['deny 가 다른 경로',   ['specs/requirements.md'], P(['specs/**'], ['src/**']),       0],
    ['write_allow 빈 단계',  ['README.md'],        P([]),                                 1],
    ['문서 0건 — 공허참',   [],                   P(['docs/**']),                         0],
    ['단계 0개',           ['README.md'],        {},                                     1],
    ['여러 단계 중 하나가 연다', ['docs/deploy.md'],
      { A: { write_allow: ['src/**'] }, B: { write_allow: ['docs/deploy.md'] } },         0],
  ];
  for (const [name, files, phases, want] of jurCases) {
    const got = judgeDocJurisdiction(files, phases).length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} 기대 ${want ? `고아 ${want}건` : '통과'} · 실측 ${got ? `고아 ${got}건` : '통과'}`);
  }

  const total = cases.length + eolCases.length + labelCases.length + coverCases.length + jurCases.length;
  console.log(bad ? `\n정책 린트 자기시험 실패 ${bad}건 / ${total}건 — 파서가 뚫린다.` : `\n정책 린트 자기시험 ${total}건 통과 (P11 파서 ${cases.length} · P9 줄바꿈 ${eolCases.length} · P12 바깥 라벨 ${labelCases.length} · P13 가드 커버리지 ${coverCases.length} · P14 문서 관할 ${jurCases.length}).`);
  process.exit(bad ? 1 : 0);
}

/**
 * 줄바꿈을 빼고 같은가. **순수 함수다** (`--self-test`).
 *
 * P9 는 "생성물이 정책 JSON 과 동기화돼 있는가"를 묻는다. 줄바꿈 종류는 그 물음의
 * 일부가 아닌데, 바이트 비교는 그것까지 센다. 이 저장소의 `.gitattributes` 는
 * `* text=auto` 라서 **Windows 체크아웃에서 README 가 CRLF 로 깔리고**, 생성기는
 * `\n` 으로 쓴다 — 커밋된 블롭은 LF 라 `git diff` 는 비었는데 P9 만 빨갛다.
 * 즉 이 게이트는 **저장소 상태가 아니라 체크아웃 환경을 재고 있었다.**
 * (`recurrence.md` R9 와 같은 부류다. 그때는 CI 의 gitignore 산출물이었고 이번엔
 * 개발기의 줄바꿈이다 — 공통 원인은 '센서가 저장소 밖 변수를 읽는다'.)
 *
 * 한 파일만 `eol=lf` 로 카브아웃하지 않는 이유: 그건 이 파일에서만 증상을 지우고
 * 다음 생성물에서 같은 실패가 다시 난다. 게다가 `* text=auto` 는 이 저장소가 이미
 * 내린 결정이고, 센서 하나를 위해 그 결정을 조각내는 것은 방향이 반대다.
 */
export function sameIgnoringEol(a, b) {
  const norm = (s) => String(s).replace(/\r\n/g, '\n');
  return norm(a) === norm(b);
}

/**
 * P12 — 최신 체크포인트의 `next`·`open_questions` 에 **저장소 밖 라벨**이 있는가.
 * **순수 함수다** (`--self-test`).
 *
 * `recurrence.md` R7 의 **재처방**이다. 1차 처방은 `checkpoint-resume` 스킬의 Guide 였고
 * 2026-08-02 에 **내가 그 규칙을 쓴 뒤에 내가 어겼다** — `next` 에 `M-1`·`M-3`·`B-1`
 * (리뷰 보고서 라벨)을 넣었고 `_workspace/` 는 gitignore 라 신선한 워크트리에 없어
 * 재개 세션이 복원할 것을 못 찾았다. GB-06 Q3 가 1/3 으로 떨어졌다.
 * 위계대로 Guide 가 실패하면 게이트로 올린다(R4 선례).
 *
 * **왜 최신 하나만 보는가**: 재개 시험이 읽는 것은 최신 체크포인트 하나다. 이력 전체를
 * 걸면 과거의 모든 체크포인트가 영구히 빨갛고, 그런 게이트는 그날로 무시된다.
 *
 * **판별**: 저장소에 실재하는 식별자(`RQ-10`·`GB-06`·`ADR-0005`·`R12`·`P11`)는 통과시키고
 * 리뷰 보고서 라벨(`M-1`·`B-1`·`m-2`·`B-j`·`N9-2`)만 잡는다. 전자는 글자 2개 이상으로
 * 시작하거나 하이픈이 없고, 후자는 **한 글자 + (숫자) + 하이픈 + 한 자리**다.
 * 스킬이 *"저장소에 실재하는 식별자는 반드시 남긴다"* 고 못박았으므로 넓게 잡으면 안 된다 —
 * 7차 재리뷰가 앵커를 지운 것이 점수를 3/5 까지 떨어뜨렸음을 실측했다.
 */
/**
 * 바깥 라벨 판별 — **좁힌 축은 라벨의 '모양'이지 '감싸는 문자'가 아니다.**
 *
 * 1차(2026-08-02)는 경계 문자류를 공백·괄호·따옴표로만 잡았다. 그런데 이 저장소의
 * 산문은 식별자를 백틱으로 감싸고 `·` 로 나열하는 것이 지배적 표기라, 실제 데이터의
 * **3분의 1이 샜다** — 재리뷰가 커밋된 체크포인트 전수에 돌려 실측했다:
 * `major-1`(reviewer 에이전트가 RQ-10 리뷰에서 실제로 생산한 라벨)이 **GB-06 이
 * 채점한 체크포인트 4건에 들어 있었는데 통과**했다. 검사 이름은 "바깥 라벨"인데
 * 실제로는 "공백으로 둘러싸인 한 글자 라벨"이었다 — R1(넓게 약속하고 좁게 집행).
 *
 * 2차는 **모양은 그대로 두고** 감싸는 문자와 접두사 어휘만 넓힌다:
 *  - 경계에 백틱·별표·중점·슬래시·여는 괄호·**한글**을 추가 (`M-1의`·`M-1·M-3`)
 *  - 접두사에 `major`/`minor`/`blocker` 리터럴 추가 (reviewer 가 쓰는 어휘)
 *  - 꼬리를 1~2자로 (`M-10`)
 *
 * 실측: 놓침 8종 회수 · **거짓 양성 증가 0** (`RQ-10을`·`GB-06[필수]`·`ADR-0005의`·
 * `x-axis(축)`·`fail-open을`·`3-1`·`24-a` 전부 통과 유지). 넓히면 거짓 양성이
 * 는다는 것이 1차의 근거였는데, **거짓 양성을 만든 것은 넓이가 아니라 축이었다.**
 */
const OUTSIDE_LABEL =
  /(^|[\s([{"'`*·、,/])((?:[A-Za-z]\d?|major|minor|blocker)-[0-9a-z]{1,2})(?=[\s:.,)\]}([{"'`*·/가-힣]|$)/gu;
export function judgeOutsideLabels(items) {
  const hits = [];
  for (const raw of items || []) {
    const text = String(raw == null ? '' : raw);
    for (const m of text.matchAll(OUTSIDE_LABEL)) hits.push({ label: m[2], text: text.slice(0, 60) });
  }
  return hits;
}

function checkCheckpointNarrative() {
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.harness/state/checkpoints'],
    { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0 || !ls.stdout.trim()) return; // 체크포인트가 없으면 이 검사의 관할이 아니다
  const rows = ls.stdout.split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.json'))
    .map((rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const mm = /^(.+?)(?:-(\d+))?\.json$/.exec(base);
      const raw = mm ? mm[1] : base;
      const t = /^(\d{8}T\d{6})(\d*)Z?$/.exec(raw);
      return { rel, stamp: t ? `${t[1]}${(t[2] || '').padEnd(3, '0').slice(0, 3)}` : raw, seq: mm && mm[2] ? Number(mm[2]) : 0 };
    })
    .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.seq - b.seq));
  if (!rows.length) return;
  const rel = rows[rows.length - 1].rel;
  const show = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' });
  if (show.status !== 0) return;
  let ck;
  try {
    ck = JSON.parse(show.stdout);
  } catch {
    return; // 깨진 체크포인트는 P12 의 관할이 아니다 — 재개 시험이 그것을 잡는다
  }
  const s = ck.session || {};
  const hits = judgeOutsideLabels([...(s.next || []), ...(s.open_questions || [])]);
  if (!hits.length) return;
  fail(
    'P12',
    `최신 체크포인트(${rel})의 next·open 에 저장소 밖 라벨 ${hits.length}건: ${[...new Set(hits.map((h) => h.label))].join(' ')}`,
    '리뷰 보고서·이슈 번호·회차 약칭은 `_workspace/` 에 살고 그건 gitignore 라 신선한 워크트리에 없다. ' +
      '재개하는 쪽은 복원할 것이 없어 자기 서사로 대체한다. 라벨을 지우고 **그 라벨이 가리키던 내용**을 쓰라 — ' +
      '파일명·스크립트명·단계명·규칙 ID 같은 저장소에 실재하는 식별자는 그대로 남긴다. ' +
      '`python harness/phase.py session --next "…"` 로 다시 선언한 뒤 전이를 한 번 거쳐야 체크포인트에 반영된다. ' +
      '(recurrence R7 재처방 — 1차 Guide 가 실패해 게이트로 올라왔다.)'
  );
}

/**
 * P13 — `phase-matrix.json` 의 가드가 전부 `harness/sensor-catalog.md` 에 언급되는가.
 * **순수 함수다** (`--self-test`).
 *
 * 왜 필요한가: 카탈로그는 자기 머리말에서 *"가드레일 지도 한 장"* 이라고 선언한다.
 * 지도에 없는 게이트는 **에이전트가 이유를 모른 채 차단당하는 자리**이고, 더 나쁘게는
 * **감사 자신이 자기가 감사하는 대상을 잘못 알게 되는 자리**다.
 *
 * 2026-08-04 감사가 F-1 로 *"스펙 동결 CI 게이트가 카탈로그에 행이 없다"* 를 잡았고
 * 처방은 **그 행 하나를 신설**하는 개별 대응이었다. 2026-08-06 감사가 방향 2 대조를
 * 기계로 돌리자 **전이 가드 3종**(`session_declared`·`tree_clean`·`tests_committed`)이
 * 같은 형상으로 비어 있었다 — **개별 대응이라 다른 축에서 그대로 재발했다.**
 * 그래서 Guide 를 게이트로 한 칸 올린다(위계: 구조 > 게이트 > 센서 > Guide).
 *
 * **부분 문자열로 판정하지 않는다.** `tree_clean` 을 단순 `includes` 로 보면
 * `tree_cleanup` 이 통과시킨다. 식별자 경계를 요구한다.
 *
 * **부정·미래 문장은 언급으로 세지 않는다.** 이 저장소의 우회는 두 번 다
 * `통과값 + 부정어` 형상이었다(`미완료` = `완료` + 부정 접두 · `완료 예정` = `완료` + 미래).
 * 카탈로그에 *"`tree_clean` 은 아직 없다"* 라고 적어 두면 그건 **등재가 아니라 부재의 고백**이다.
 *
 * **코드 펜스 안은 보지 않는다.** 예시 블록에 이름이 스쳐 지나가는 것은 지도가 아니다.
 */
export function judgeGuardCoverage(guardNames, catalogText) {
  const body = String(catalogText || '').replace(/```[\s\S]*?```/g, '');
  const NEGATED = /(아직|없다|없음|미등재|누락|예정|추가할|넣을|올릴|TODO|미배선)/;
  const WINDOW = 40;
  const missing = [];
  for (const g of guardNames || []) {
    const re = new RegExp(`(^|[^0-9A-Za-z_])${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z_]|$)`, 'g');
    let mentioned = false;
    for (const m of body.matchAll(re)) {
      // 부정은 **가드 이름 바로 뒤 창** 안에서만 센다. 줄 전체를 보면 등재 행의
      // 설명 문장("…쓸 수 없다")이 오탐을 낸다 — 실제로 이 검사를 넣은 날 그렇게 걸렸다.
      // 창은 줄 끝에서 자른다: 다음 줄의 부정어가 이 줄의 등재를 취소하지 않는다.
      const start = m.index + m[0].length;
      const eol = body.indexOf('\n', start);
      const end = Math.min(start + WINDOW, eol === -1 ? body.length : eol);
      if (!NEGATED.test(body.slice(start, end))) { mentioned = true; break; }
    }
    if (!mentioned) missing.push(g);
  }
  return missing;
}

function checkGuardCoverage(m) {
  const guards = Object.keys((m || {}).guards || {});
  if (!guards.length) return; // 가드가 없으면 이 검사의 관할이 아니다 — P5 가 죽은 참조를 본다
  if (!existsSync(CATALOG)) {
    fail('P13', 'harness/sensor-catalog.md 가 없다 — 가드레일 지도가 사라졌다',
      '카탈로그를 복구하라. 지도 없는 게이트는 에이전트가 이유를 모른 채 차단당하는 자리다.');
    return;
  }
  const missing = judgeGuardCoverage(guards, readFileSync(CATALOG, 'utf8'));
  if (!missing.length) {
    note('P13', `전이 가드 ${guards.length}종 전부 센서 카탈로그에 등재됨`);
    return;
  }
  fail(
    'P13',
    `phase-matrix 의 가드 ${missing.length}종이 harness/sensor-catalog.md 에 없다: ${missing.join(' · ')}`,
    '카탈로그에 각 가드의 행을 추가한다 — **무엇을 막는가 · 어느 전이에 걸리는가 · 강제 수단은 무엇인가**. ' +
      '지도에 없는 게이트는 에이전트가 이유를 모른 채 차단당하는 자리이고, 감사 자신이 대상을 잘못 알게 되는 자리다. ' +
      '가드를 지웠다면 phase-matrix.json 에서도 지워라 — P5 가 죽은 참조를 따로 잡는다. ' +
      '(2026-08-06 감사: F-1 의 개별 대응이 다른 축에서 재발해 Guide 를 게이트로 올렸다.)'
  );
}

/**
 * P14 — `doc-map.json` 이 관할하는 문서가 **최소 한 단계에서 쓰기 가능**한가.
 * **순수 함수다** (`--self-test`).
 *
 * 왜 필요한가: 두 정책 파일이 서로 반대를 말할 수 있고, 실제로 말하고 있었다.
 * `doc-freshness` C2 는 관할 문서의 갱신을 **요구**하는데 `gate_phase.py` 는 그
 * 갱신을 **거부**한다 — 남는 통로가 `force` 뿐이고, force 는 주간 리포트 최상단에
 * 박제된다. **정직하게 일한 대가로 지표가 나빠지는 배치**다.
 *
 * 2026-08-06 감사가 두 JSON 을 기계로 대조해 고아 3건을 실측했다:
 * `README.md`(저장소 정문 · depends_on 2건이라 C2 가 실제로 발화한다) ·
 * `docs/deploy.md` · `docs/design/handoff-brief.md`. 여태 안 터진 이유는
 * 이 셋의 수정이 `enforce.warn_only` 단계에서 일어나 **경고로 지나갔기** 때문이고,
 * 게이트를 나머지 단계에 켜는 순간 즉시 차단이 된다.
 *
 * **모순이 파일 둘 사이에 있으므로 한쪽을 고쳐선 재발을 못 막는다** — 그래서 게이트다.
 * 구조로 풀 수 있는지 먼저 쟀고(위계: 구조 > 게이트 > 센서 > Guide), 3건 중 1건만
 * 옮기기로 풀렸다. `README.md` 는 정문이라 옮길 수 없다.
 *
 * **`write_deny` 를 함께 본다.** 어느 단계가 `docs/**` 를 열어 두고 다른 규칙이
 * 같은 단계에서 그것을 막으면 그 단계는 통로가 아니다 — 허용만 세면 고아를 놓친다.
 *
 * @param docFiles 관할 문서의 **구체 경로** 목록 (패턴이 아니라 전개된 실파일).
 *                 패턴끼리 포함관계를 판정하는 것보다 훨씬 단순하고 오탐이 없다.
 * @param phases   `phase-matrix.json` 의 `phases` 객체.
 */
export function judgeDocJurisdiction(docFiles, phases) {
  const ps = Object.values(phases || {}).filter((p) => p && typeof p === 'object');
  const writable = (f) =>
    ps.some(
      (p) =>
        (p.write_allow || []).some((a) => globToRegExp(a).test(f)) &&
        !(p.write_deny || []).some((d) => globToRegExp(d).test(f))
    );
  return (docFiles || []).filter((f) => !writable(f));
}

function checkDocJurisdiction(m) {
  if (!existsSync(DOC_MAP)) return; // 문서 레지스트리가 없으면 이 검사의 관할이 아니다
  let map;
  try {
    map = JSON.parse(readFileSync(DOC_MAP, 'utf8'));
  } catch {
    return; // JSON 파손은 doc-freshness 가 자기 이름으로 보고한다 — 여기서 이중 보고하지 않는다
  }
  // 레지스트리의 path 는 패턴일 수 있다(`docs/adr/*.md`). 실파일로 전개해서 본다 —
  // 실재하지 않는 등록은 doc-freshness C1 의 관할이지 이 검사의 관할이 아니다.
  const files = [];
  for (const d of map.docs || []) {
    for (const f of globSync(d.path, { cwd: ROOT })) files.push(f.split(sep).join('/'));
  }
  const orphans = [...new Set(files)].sort();
  const missing = judgeDocJurisdiction(orphans, (m || {}).phases);
  if (!missing.length) {
    note('P14', `관할 문서 ${orphans.length}건 전부 쓰기 가능한 단계가 있음`);
    return;
  }
  for (const f of missing) {
    fail(
      'P14',
      `관할 문서인데 어느 단계에서도 쓸 수 없다: ${f}`,
      'doc-freshness 는 이 문서의 갱신을 요구하고(C2), gate_phase 는 그 갱신을 거부한다. ' +
        '남는 통로는 force 뿐이고 force 는 주간 리포트 최상단에 박제된다 — 정직하게 일한 대가로 지표가 나빠진다. ' +
        '고치는 법 (둘 중 하나): ' +
        '(a) harness/policy/phase-matrix.json 의 어느 단계 write_allow 에 이 경로를 넣어라 — ' +
        '성격이 자리를 정한다: 스펙·설계는 SPEC, 하네스·CI 는 HARNESS. ' +
        '(b) 관리 대상이 아니면 harness/doc-map.json 의 docs[] 에서 빼라. ' +
        '둘 다 아니면 이 문서는 "고치라고 요구받지만 고칠 수 없는" 상태로 남는다.'
    );
  }
}

function checkGenerated(m, r) {
  const rendered = renderReadme(m, r);
  if (!existsSync(README)) {
    fail('P9', 'harness/policy/README.md가 없다 — 정책의 사람용 표가 생성되지 않았다', 'node scripts/policy-lint.mjs --print 로 생성하고 커밋하라.');
    return;
  }
  if (!sameIgnoringEol(readFileSync(README, 'utf8'), rendered)) {
    fail(
      'P9',
      'harness/policy/README.md가 정책 JSON과 어긋났다 — 생성물이 낡았다',
      'node scripts/policy-lint.mjs --print 로 재생성하고 **같은 커밋에 포함하라**. ' +
        'README는 손으로 고치는 파일이 아니므로 어긋난 채로 두면 아무도 다시 안 본다 — ' +
        '표를 생성물로 만든 목적이 사라진다.'
    );
  }
}

// ── README 생성 ─────────────────────────────────────────────────────────────
function cell(v) {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => '`' + x + '`').join(' ') : '—';
  return String(v).replace(/\|/g, '\\|');
}

function renderReadme(m, r) {
  const L = [];
  L.push('# 정책 표 — 생성물 (손으로 고치지 마라)');
  L.push('');
  L.push('이 파일은 `node scripts/policy-lint.mjs --print` 가 `harness/policy/*.json`에서 생성한다.');
  L.push('손으로 고치면 다음 생성에서 지워진다. 표를 바꾸고 싶으면 **JSON을 바꾸고 다시 생성**하라 —');
  L.push('표와 정책이 어긋날 자리를 없애는 것이 이 파일이 생성물인 유일한 이유다.');
  L.push('');
  L.push('> 갱신일을 여기 적지 않는다. 날짜는 `git log -1 --format=%cI -- harness/policy/README.md` 가 안다.');
  L.push('');

  const enf = m.enforce || {};
  L.push('## 집행 수준');
  L.push('');
  L.push('| 항목 | 값 |');
  L.push('|---|---|');
  L.push(`| 기본 | \`${enf.default}\` |`);
  L.push(`| 경고만(warn_only) | ${cell(enf.warn_only)} |`);
  L.push('');
  L.push('`warn_only` 단계는 차단 대신 stderr 경고만 낸다. 게이트의 첫 주가 가장 위험하므로');
  L.push('(차단이 잦으면 `force`가 습관이 되고 그 순간 전체가 장식이 된다) 일부 단계를 유예한다.');
  L.push('**`force` 비율이 5%를 넘으면 에이전트가 아니라 이 매트릭스가 틀렸다는 신호다.**');
  L.push('');

  L.push('## 단계 × 경로 (R1 — 로컬 변경)');
  L.push('');
  L.push('기본값은 default-deny. `write_allow`에 걸리지 않으면 막힌다. `write_deny`는 메시지 품질용');
  L.push('명시 목록이다 — "왜 막혔는가"를 정확히 말하기 위해 존재한다.');
  L.push('');
  L.push('| 단계 | 목적 | write_allow | write_deny |');
  L.push('|---|---|---|---|');
  for (const [name, p] of Object.entries(m.phases || {})) {
    L.push(`| \`${name}\` | ${cell(p.purpose)} | ${cell(p.write_allow)} | ${cell(p.write_deny)} |`);
  }
  L.push('');

  L.push('### 나가는 길 (exit_hint)');
  L.push('');
  L.push('| 단계 | 다음 |');
  L.push('|---|---|');
  for (const [name, p] of Object.entries(m.phases || {})) {
    L.push(`| \`${name}\` | ${cell(p.exit_hint)} |`);
  }
  L.push('');

  L.push('## 전이와 가드');
  L.push('');
  L.push('합법적 간선도 **직전 단계만 만들 수 있는 산출물**을 요구한다.');
  L.push('단계를 뒤집는 것은 막을 수 없지만, 뒤집어도 얻는 게 없다.');
  L.push('');
  L.push('| from | to | 가드 |');
  L.push('|---|---|---|');
  for (const t of m.transitions || []) {
    const tos = (Array.isArray(t.to) ? t.to : [t.to]).map((x) => '`' + x + '`').join(' · ');
    L.push(`| \`${t.from}\` | ${tos} | ${cell(t.guards)} |`);
  }
  L.push('');

  L.push('### 가드 정의');
  L.push('');
  L.push('| 가드 | 종류 | 판정 대상 | 막혔을 때 |');
  L.push('|---|---|---|---|');
  for (const [name, g] of Object.entries(m.guards || {})) {
    const target =
      g.cmd ? '`' + g.cmd.join(' ') + '`' :
      g.file ? '`' + g.file + '`' :
      g.expr ? '`' + g.expr + '`' : '—';
    L.push(`| \`${name}\` | ${cell(g.kind)} | ${target} | ${cell(g.fail_hint)} |`);
  }
  L.push('');

  L.push('## 위험 등급 (도구)');
  L.push('');
  L.push('축은 "가역성 × 경계 이탈"이다 — 파일 경로가 아니라 도구의 성질로 나눈다.');
  L.push('');
  L.push('| 등급 | 이름 | 정의 | 정책 | 강제 주체 |');
  L.push('|---|---|---|---|---|');
  for (const [tier, t] of Object.entries(r.tiers || {})) {
    // enforced_by는 경로가 아니라 라벨이다 — 백틱으로 감싸면 doc-freshness C4가 경로로 오인한다
    L.push(`| **${tier}** | ${cell(t.label)} | ${cell(t.definition)} | ${cell(t.policy)} | ${cell(t.enforced_by)} |`);
  }
  L.push('');

  L.push('### 파일 도구');
  L.push('');
  L.push('| 등급 | 도구 |');
  L.push('|---|---|');
  for (const [tier, list] of Object.entries(r.file_tools || {})) {
    L.push(`| ${tier} | ${cell(list)} |`);
  }
  L.push('');

  L.push('### Bash 접두사');
  L.push('');
  L.push('| 등급 | 접두사 |');
  L.push('|---|---|');
  for (const [tier, list] of Object.entries(r.bash_prefixes || {})) {
    L.push(`| ${tier} | ${cell(list)} |`);
  }
  L.push('');
  L.push(`미지의 접두사: **${cell((r.unknown_prefix_policy || {}).decision)}**`);
  L.push('');

  L.push('### 보호 경로 (리다이렉트 차단)');
  L.push('');
  L.push(cell((r.protected_paths || {}).deny_redirect));
  L.push('');
  L.push('Bash 리다이렉트(`> path` / `>> path`)로 통제면을 우회하는 시도를 **탐지**한다.');
  L.push('예방이 아니다 — `node -e "fs.writeFileSync(...)"` 같은 우회는 문자열 파싱으로 막을 수 없다.');
  L.push('사후 대조는 `node scripts/phase-audit.mjs`가 git 이력에서 독립적으로 수행한다.');
  L.push('');

  return L.join('\n') + '\n';
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('사용법: node scripts/policy-lint.mjs [--print|--self-test]');
  console.log('  (인자 없음)  harness/policy/*.json 검증. 실패 시 exit 1');
  console.log('  --print      harness/policy/README.md 재생성 (검증도 함께 수행)');
  console.log('  --self-test  순수 함수 음성 시험 (P11 파서 · P9 줄바꿈 · P12 바깥 라벨 · P13 가드 커버리지 · P14 문서 관할)');
  process.exit(0);
}
if (args.includes('--self-test')) selfTest();

if (matrix) {
  checkMatrixSchema(matrix);
  checkReachability(matrix);
  checkWriteAllow(matrix);
  checkGuards(matrix);
  checkShadowing(matrix);
}
checkRecurrence();
checkCheckpointNarrative();
if (matrix) checkGuardCoverage(matrix);
if (matrix) checkDocJurisdiction(matrix);
if (matrix) checkPatterns(matrix);
if (risk) checkRisk(risk);
if (matrix && risk && !args.includes('--print')) checkGenerated(matrix, risk);
if (risk) checkEnforcement(risk);

console.log('정책 린트 — harness/policy/');
console.log('');
if (matrix) {
  const phaseCount = Object.keys(matrix.phases || {}).length;
  const guardCount = Object.keys(matrix.guards || {}).length;
  console.log(`  phase-matrix.json : 단계 ${phaseCount} · 전이 ${(matrix.transitions || []).length} · 가드 ${guardCount}`);
}
if (risk) {
  const prefixCount = Object.values(risk.bash_prefixes || {}).reduce((n, l) => n + l.length, 0);
  console.log(`  tool-risk.json    : 등급 ${Object.keys(risk.tiers || {}).length} · bash 접두사 ${prefixCount} · 보호 경로 ${((risk.protected_paths || {}).deny_redirect || []).length}`);
}
console.log('');

const checks = [
  ['P1', '스키마 유효성'],
  ['P2', 'IDLE에서 전 단계 도달 가능'],
  ['P3', '빈 write_allow 없음'],
  ['P4', '전이 그래프 연결 (모든 단계 → IDLE)'],
  ['P5', '미정의 가드 참조 없음'],
  ['P6', 'deny가 자기 allow를 가리지 않음'],
  ['P7', 'tool-risk 무결성'],
  ['P8', '매칭 불가능한 패턴 없음'],
  ['P9', '생성물(README) 동기화'],
  ['P10', 'enforced_by 대조 (settings.json 실집행)'],
  ['P11', '반복 대장 — 2회 이상 미처방 없음'],
  ['P12', '최신 체크포인트 서사에 저장소 밖 라벨 없음 (R7 재처방)'],
  ['P13', '전이 가드가 전부 센서 카탈로그에 등재됨 (F-1 재처방)'],
  ['P14', 'doc-map 이 관할하는 문서가 전부 최소 한 단계에서 쓰기 가능 (두 정책 파일의 모순)'],
];
for (const [id, label] of checks) {
  const n = problems.filter((p) => p.id === id).length;
  // --print 는 스스로 재생성하므로 P9 를 돌리지 않는다. 안 돈 검사를 PASS 로 찍으면
  // '검사했고 통과했다'로 읽힌다 — 안 한 것과 통과한 것은 다르다.
  const skipped = id === 'P9' && args.includes('--print');
  const mark = skipped ? 'SKIP' : n === 0 ? 'PASS' : 'FAIL';
  const suffix = skipped
    ? ' (--print 가 재생성한다)'
    : n
      ? ` — ${n}건`
      : '';
  console.log(`  ${mark}  ${id}  ${label}${suffix}`);
}

if (notes.length) {
  console.log('');
  console.log('참고:');
  for (const n of notes) console.log(`  · [${n.id}] ${n.what}`);
}

if (problems.length) {
  console.log('');
  for (const p of problems) {
    console.log(`FAIL [${p.id}] ${p.what}`);
    console.log(`     고치는 법: ${p.how}`);
  }
  console.log('');
  console.log(`정책 린트 실패 — ${problems.length}건. 위 "고치는 법"을 따라 harness/policy/*.json을 고쳐라.`);
  process.exit(1);
}

if (args.includes('--print')) {
  if (!matrix || !risk) {
    console.error('README를 생성하려면 phase-matrix.json과 tool-risk.json이 둘 다 필요하다.');
    process.exit(1);
  }
  const out = renderReadme(matrix, risk);
  const prev = existsSync(README) ? readFileSync(README, 'utf8') : null;
  writeFileSync(README, out, 'utf8');
  console.log('');
  console.log(
    prev === out
      ? '  harness/policy/README.md — 변경 없음 (정책과 표가 일치한다)'
      : `  harness/policy/README.md ${prev === null ? '생성' : '갱신'} — ${out.split('\n').length}줄`
  );

  // 디스크가 최신인 것과 "커밋해야 하는가"는 다른 질문이다. 재생성한 뒤에는 후자가 남는다.
  const tracked = spawnSync(
    'git',
    ['diff', '--quiet', 'HEAD', '--', 'harness/policy/README.md'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (!tracked.error && tracked.status === 1) {
    console.log('  ⚠ 커밋되지 않았다 — 정책 JSON과 같은 커밋에 README.md를 포함하라.');
  }
}

console.log('');
console.log('정책 린트 통과.');
process.exit(0);
