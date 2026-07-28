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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX = join(ROOT, 'harness/policy/phase-matrix.json');
const RISK = join(ROOT, 'harness/policy/tool-risk.json');
const README = join(ROOT, 'harness/policy/README.md');
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
  const hasSection = lines.some((l) => /^##\s*대장\s*$/.test(l));
  const headerIdx = lines.findIndex((l) => /^\|\s*ID\s*\|/.test(l));
  if (!hasSection) {
    problems.push('`## 대장` 절이 없다 — 대장 형식이 깨졌거나 다른 파일이다');
    return { problems, rows: [], open: [] };
  }
  if (headerIdx < 0) {
    problems.push('`| ID | …` 헤더 행을 찾지 못했다 — 표 파싱 실패');
    return { problems, rows: [], open: [] };
  }
  const width = splitRow(lines[headerIdx]).length;

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    if (i === headerIdx) continue;
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
    if (n >= RECURRENCE_THRESHOLD && /미처방|처방 실패|미정|미결|관찰 중/.test(`${cure} ${status}`)) {
      open.push(`${id}(${n}회) ${String(cause).replace(/\*/g, '').slice(0, 60)}`);
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
  console.log(bad ? `\nP11 자기시험 실패 ${bad}건 — 파서가 뚫린다.` : '\nP11 자기시험 8건 통과.');
  process.exit(bad ? 1 : 0);
}

function checkGenerated(m, r) {
  const rendered = renderReadme(m, r);
  if (!existsSync(README)) {
    fail('P9', 'harness/policy/README.md가 없다 — 정책의 사람용 표가 생성되지 않았다', 'node scripts/policy-lint.mjs --print 로 생성하고 커밋하라.');
    return;
  }
  if (readFileSync(README, 'utf8') !== rendered) {
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
  console.log('  --self-test  P11 파서 음성 시험 — 뚫려야 할 것이 실제로 뚫리는지');
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
