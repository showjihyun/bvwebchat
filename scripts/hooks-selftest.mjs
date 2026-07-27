#!/usr/bin/env node
/**
 * scripts/hooks-selftest.mjs — 훅 자체를 테스트한다.
 *
 * **테스트 없는 게이트는 연극이다.**
 *
 * `.claude/settings.json`의 커맨드 문자열을 **그대로** 읽어, 격리된 샌드박스에서
 * 합성 페이로드를 stdin으로 먹이고 allow/deny/ask 판정을 단언한다.
 * 게이트가 실제로 작동한다는 유일한 기계적 증거다 — 훅 소스를 읽는 것으로는
 * 증명되지 않는다. 이 저장소는 이미 두 번 물렸다 (docs/harness/changelog.md 2026-07-16):
 *   · python3 → python  (인터프리터 부재로 훅이 무음 실패 = fail-open)
 *   · bash → Git Bash 절대경로  (이식성 파손)
 * 그리고 이 스크립트를 쓰는 도중에 세 번째로 물렸다: settings.json이 삭제된
 * gate_spec_freeze.py를 가리켜 저장소의 **모든 Write가 차단**됐다.
 * 세 번 다 "훅 파일을 읽어서는 절대 안 보이는" 실패다.
 *
 *   node scripts/hooks-selftest.mjs            전체 (이식성 감사 + 판정 단언)
 *   node scripts/hooks-selftest.mjs --audit    이식성 감사만 (훅 실행 없음, 즉시)
 *   node scripts/hooks-selftest.mjs --keep     샌드박스를 지우지 않는다 (디버깅)
 *   node scripts/hooks-selftest.mjs --verbose  판정마다 훅의 stderr/stdout을 보여준다
 */
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { resolve, join, delimiter, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const SETTINGS = join(ROOT, '.claude/settings.json');
const MATRIX = join(ROOT, 'harness/policy/phase-matrix.json');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/hooks-selftest.mjs [--audit] [--keep] [--verbose]');
  process.exit(0);
}
const AUDIT_ONLY = argv.includes('--audit');
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('--verbose');

const findings = []; // {level:'FAIL'|'WARN', what, how}
function fail(what, how) {
  findings.push({ level: 'FAIL', what, how });
}
function warn(what, how) {
  findings.push({ level: 'WARN', what, how });
}

// ── settings.json 읽기 ──────────────────────────────────────────────────────
if (!existsSync(SETTINGS)) {
  console.error('.claude/settings.json이 없다 — 검사할 훅 배선 자체가 없다.');
  console.error('고치는 법: .claude/settings.json에 permissions/hooks를 정의하라. 훅이 없으면 경계면도 없다.');
  process.exit(1);
}
let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  console.error(`.claude/settings.json 파싱 실패: ${e.message}`);
  console.error('고치는 법: JSON 문법 오류를 고쳐라. 이 파일이 깨지면 Claude Code는 훅을 하나도 걸지 않는다 — 조용한 fail-open이다.');
  process.exit(1);
}

/** settings.json의 훅을 (이벤트, matcher, 커맨드 문자열) 평면 목록으로. 커맨드는 절대 재작성하지 않는다. */
const hooks = [];
for (const [event, groups] of Object.entries(settings.hooks || {})) {
  for (const g of groups || []) {
    for (const h of g.hooks || []) {
      if (h.type !== 'command' || !h.command) continue;
      hooks.push({ event, matcher: g.matcher || '*', command: h.command });
    }
  }
}

// ── 커맨드 분해 (셸을 거치지 않는다 — 셸을 쓰면 이식성 검사가 무의미해진다) ──
function tokenize(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of cmd) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function which(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) {
    for (const cand of [join(ROOT, cmd), cmd]) if (existsSync(cand)) return cand;
    return null;
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// ── L1 이식성 감사 (모든 훅, 모든 이벤트) ───────────────────────────────────
const SCRIPT_EXT = /\.(py|mjs|cjs|js|sh|ps1)$/;
const auditRows = [];
for (const h of hooks) {
  const argvv = tokenize(h.command);
  const row = { ...h, argv: argvv, notes: [] };
  const interp = argvv[0];
  const resolved = interp ? which(interp) : null;

  if (!interp) {
    fail(`빈 훅 커맨드 (${h.event})`, 'settings.json에서 이 훅 항목을 지우거나 커맨드를 채워라.');
  } else if (!resolved) {
    fail(
      `${h.event} 훅의 인터프리터 '${interp}'를 PATH에서 찾을 수 없다 — 이 훅은 무음 실패한다 (fail-open)`,
      `PATH에 있는 이름으로 바꿔라. 이 저장소는 python3→python으로 이미 한 번 물렸다(changelog 2026-07-16). ` +
        `CI(ubuntu-latest)와 Windows 양쪽에 존재하는 이름인지 확인하라.`
    );
  } else {
    row.notes.push(`인터프리터 OK: ${interp}`);
  }

  for (const tok of argvv) {
    if (/^[A-Za-z]:[\\/]/.test(tok) || (tok.startsWith('/') && !tok.startsWith('//'))) {
      fail(
        `${h.event} 훅에 절대경로가 있다: ${tok}`,
        `저장소 루트 기준 상대경로로 바꿔라. 절대경로는 다른 머신·CI·워크트리에서 즉시 깨진다 ` +
          `(changelog 2026-07-16: 'C:\\Program Files\\Git\\bin\\bash.exe'로 한 번 물렸다).`
      );
    }
    if (tok.includes('\\') && !tok.startsWith('-')) {
      fail(`${h.event} 훅 경로에 역슬래시가 있다: ${tok}`, '슬래시(/)로 바꿔라. 역슬래시 경로는 ubuntu-latest에서 파일명의 일부로 해석된다.');
    }
    if (SCRIPT_EXT.test(tok) && !isAbsolute(tok)) {
      const abs = join(ROOT, tok);
      if (!existsSync(abs)) {
        fail(
          `${h.event} 훅이 실재하지 않는 스크립트를 가리킨다: ${tok}`,
          `파일을 만들거나 settings.json에서 이 훅을 빼라. 존재하지 않는 훅은 매 도구 호출마다 오류를 내고, ` +
            `PreToolUse라면 **해당 도구 전체가 막힌다** — 실제로 이 저장소에서 발생했다.`
        );
      } else {
        const buf = readFileSync(abs);
        if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          fail(`${tok}에 UTF-8 BOM이 있다`, 'BOM 없이 저장하라. 셔뱅 앞의 BOM은 인터프리터가 파일을 실행 불가로 판단하게 만든다.');
        }
        if (tok.endsWith('.sh') && buf.includes(Buffer.from('\r\n'))) {
          fail(`${tok}에 CRLF 줄바꿈이 있다`, 'LF로 바꿔라. CRLF 셸 스크립트는 리눅스에서 "bad interpreter" 오류를 낸다.');
        }
        row.notes.push(`스크립트 OK: ${tok}`);
      }
    }
  }
  auditRows.push(row);
}

// 필수 배선 존재 여부 — 게이트가 아예 안 걸려 있으면 그것이 최악이다
const preToolHooks = hooks.filter((h) => h.event === 'PreToolUse');
if (preToolHooks.length === 0) {
  fail(
    'PreToolUse 훅이 하나도 없다 — 단계×경로 게이트가 걸려 있지 않다',
    '.claude/settings.json의 hooks.PreToolUse에 gate 훅을 배선하라. 정책 파일만 있고 훅이 없으면 phase-matrix.json은 읽히지 않는 문서다.'
  );
}

// ── 출력: 이식성 감사 ───────────────────────────────────────────────────────
console.log('훅 자기검사 — .claude/settings.json의 커맨드 문자열을 그대로 실행한다');
console.log('');
console.log('── L1 이식성 감사 ────────────────────────────────────────────────────');
console.log(`  ${hooks.length}개 훅 배선`);
for (const r of auditRows) {
  const bad = findings.some((f) => f.what.includes(r.event) && f.what.includes(r.argv[r.argv.length - 1] || ''));
  console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${r.event.padEnd(14)} [${r.matcher}]  ${r.command}`);
}
console.log('');

// ── L2 판정 단언 ────────────────────────────────────────────────────────────
let matrix;
try {
  matrix = JSON.parse(readFileSync(MATRIX, 'utf8'));
} catch {
  matrix = null;
}
const WARN_ONLY = new Set((matrix?.enforce?.warn_only || []).map(String));

/** phase.json 서명 — harness/_state.py의 sign()과 같은 규약(정렬 키·공백 없음·UTF-8·HMAC-SHA256). */
function signState(body, key) {
  const sorted = {};
  for (const k of Object.keys(body).filter((k) => k !== 'sig').sort()) sorted[k] = body[k];
  return createHmac('sha256', key).update(Buffer.from(JSON.stringify(sorted), 'utf8')).digest('hex');
}

/**
 * 샌드박스: 진짜 저장소의 `.harness/state/`를 절대 건드리지 않는다.
 * 자기검사가 개발자의 라이브 단계를 바꿔 버리면 그 순간 아무도 안 돌린다.
 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-selftest-'));
  writeFileSync(join(dir, 'CLAUDE.md'), '# 샌드박스 루트 표식 (hooks-selftest)\n', 'utf8');
  for (const rel of ['.claude/hooks', '.claude/settings.json', 'harness/policy', 'harness/_state.py', 'harness/phase.py', 'harness/doc-map.json']) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) continue;
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    cpSync(src, join(dir, rel), { recursive: true, filter: (s) => !s.includes('__pycache__') });
  }
  if (existsSync(join(ROOT, 'specs/requirements.md'))) {
    mkdirSync(join(dir, 'specs'), { recursive: true });
    cpSync(join(ROOT, 'specs/requirements.md'), join(dir, 'specs/requirements.md'));
  }
  mkdirSync(join(dir, '.harness/state'), { recursive: true });
  mkdirSync(join(dir, '.harness/logs'), { recursive: true });
  // 진짜 키는 절대 복사하지 않는다 — 샌드박스 전용 키를 새로 만든다
  const key = Buffer.from('0'.repeat(8) + 'selftest'.repeat(6) + '0'.repeat(8), 'ascii');
  writeFileSync(join(dir, '.harness/state/.key'), key);
  return { dir, key };
}

/** state: {phase} | {corrupt:true} | {tampered:'PHASE'} | {missing:true} */
function writeState(box, state) {
  const p = join(box.dir, '.harness/state/phase.json');
  if (state.missing) {
    rmSync(p, { force: true });
    return;
  }
  if (state.corrupt) {
    writeFileSync(p, '{ "phase": "HARNESS", this is not json', 'utf8');
    return;
  }
  const body = {
    branch: 'harness/selftest',
    forced: false,
    from: 'IDLE',
    head_sha: '0'.repeat(40),
    phase: state.tampered || state.phase,
    rq: 'SELFTEST',
    updated: '2026-01-01T00:00:00Z',
  };
  body.sig = state.tampered ? 'f'.repeat(64) : signState(body, box.key);
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
}

function matcherHits(matcher, tool) {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

/** 훅 실행 결과 → allow | deny | ask | warn | error */
function decisionOf(res) {
  const out = (res.stdout || '').trim();
  if (out.startsWith('{')) {
    try {
      const j = JSON.parse(out);
      const d = j?.hookSpecificOutput?.permissionDecision || j?.permissionDecision;
      if (d) return d;
      if (j?.decision === 'block') return 'deny';
    } catch {
      /* JSON이 아니면 종료 코드로 판정 */
    }
  }
  if (res.status === 2) return 'deny';
  if (res.status === 0) return (res.stderr || '').trim() ? 'warn' : 'allow';
  return 'error';
}

const RANK = { allow: 0, warn: 1, ask: 2, deny: 3, error: 4 };

/**
 * 시나리오의 intent는 **정책 의도**(allow/deny)다.
 * 해당 단계가 enforce.warn_only에 있으면 기대값을 자동으로 warn으로 낮춘다 —
 * 그래야 W4의 block 전환 전후에 같은 시나리오 표가 그대로 옳다. 유예 여부가 출력에 드러난다.
 */
const SCENARIOS = [
  { id: 'S01', must: true, phase: 'RED', tool: 'Write', path: 'src/server/chat/room.ts', intent: 'deny', why: 'RED에서 구현 파일 쓰기 — 이 게이트의 존재 이유' },
  { id: 'S02', must: true, phase: 'RED', tool: 'Write', path: 'tests/integration/rq-99-x.test.ts', intent: 'allow', why: 'RED의 산출물은 테스트다' },
  { id: 'S03', must: true, phase: 'GREEN', tool: 'Write', path: 'tests/integration/rq-99-x.test.ts', intent: 'deny', why: 'GREEN에서 기대값 수정 — GB-05가 구조적으로 불가능해지는 지점' },
  { id: 'S04', phase: 'GREEN', tool: 'Write', path: 'src/server/chat/room.ts', intent: 'allow', why: 'GREEN의 산출물은 구현이다' },
  { id: 'S05', must: true, phase: 'RED', tool: 'Bash', cmd: 'echo tampered > .harness/state/phase.json', intent: 'deny', why: '리다이렉트로 상태 파일 덮어쓰기 — 통제면 우회 탐지' },
  { id: 'S06', phase: 'RED', tool: 'Bash', cmd: 'printf x >> evals/golden/track-a-product.jsonl', intent: 'deny', why: '골든 정답에 append — 보호 경로' },
  { id: 'S07', phase: 'RED', tool: 'Bash', cmd: 'git status --short', intent: 'allow', why: 'R0 관찰 명령은 전 단계 통과' },
  { id: 'S08', phase: 'RED', tool: 'Bash', cmd: 'node scripts/check.mjs > _workspace/out.txt', intent: 'allow', why: '보호 경로가 아닌 리다이렉트까지 막으면 과잉 차단이다' },
  { id: 'S09', phase: 'HARNESS', tool: 'Write', path: 'scripts/metrics.mjs', intent: 'allow', why: 'HARNESS는 하네스 파일 전용 단계' },
  { id: 'S10', phase: 'HARNESS', tool: 'Write', path: 'src/server/main.ts', intent: 'deny', why: '하네스 PR에 기능 코드가 섞이는 것을 구조로 막는다 (CLAUDE.md 카브아웃의 승격)' },
  { id: 'S11', phase: 'EVAL', tool: 'Write', path: 'scripts/x.mjs', intent: 'deny', why: 'EVAL은 보고서만 쓴다' },
  { id: 'S12', phase: 'REVIEW', tool: 'Write', path: '_workspace/review/x.md', intent: 'allow', why: '리뷰 보고서 경로' },
  { id: 'S13', phase: 'RED', tool: 'Write', path: 'docs/progress.md', intent: 'allow', why: '원장은 전 단계에서 갱신 가능해야 한다' },
  { id: 'S14', phase: 'RED', tool: 'Write', path: 'specs/requirements.md', intent: 'deny', why: 'RED에서 스펙을 고치는 것은 테스트를 스펙에 맞추는 게 아니라 반대다' },
  { id: 'S15', phase: 'IDLE', tool: 'Write', path: 'src/server/main.ts', intent: 'deny', why: 'IDLE은 fail-closed 기본값 — _workspace 외에는 못 쓴다' },
  { id: 'S16', must: true, state: { corrupt: true }, effectivePhase: 'IDLE', tool: 'Write', path: 'scripts/x.mjs', intent: 'deny', why: '상태 파일 손상 → fail-CLOSED. 조용히 통과시키면 상태를 깨뜨리는 것이 게이트 우회법이 된다' },
  { id: 'S17', must: true, state: { tampered: 'HARNESS' }, effectivePhase: 'IDLE', tool: 'Write', path: 'scripts/x.mjs', intent: 'deny', why: '서명 불일치 → 손으로 고친 상태를 믿지 않는다' },
  { id: 'S18', state: { missing: true }, effectivePhase: 'IDLE', tool: 'Write', path: 'src/server/main.ts', intent: 'deny', why: '상태 파일 부재 → IDLE' },
  { id: 'S19', phase: 'RED', tool: 'Write', path: 'tests/integration/한글-경로-테스트.test.ts', intent: 'allow', why: '한글 경로 — cp949 디코딩 실패로 게이트가 죽지 않는지' },
  { id: 'S20', phase: 'RED', tool: 'Write', path: '_workspace/메모 노트.md', intent: 'allow', why: '공백+한글 경로' },
  { id: 'S21', phase: 'RED', tool: 'Read', path: 'src/server/main.ts', intent: 'allow', why: 'R0 읽기는 게이트의 관할이 아니다 (matcher에서 걸러져야 한다)' },
  { id: 'S22', phase: 'RED', tool: 'Write', outside: true, intent: 'allow', why: '저장소 밖 경로는 이 게이트의 관할이 아니다' },
  { id: 'S23', phase: 'RED', tool: 'Write', malformed: true, intent: 'allow', expectExit: 0, why: '깨진 stdin — 훅이 크래시하면 안 된다 (크래시 = fail-open)' },
];

const results = [];
let box = null;
let maxMs = 0;

if (!AUDIT_ONLY) {
  const missingHooks = preToolHooks.filter((h) => {
    const t = tokenize(h.command).find((x) => SCRIPT_EXT.test(x));
    return t && !existsSync(join(ROOT, t));
  });
  if (missingHooks.length) {
    console.log('── L2 판정 단언 ──────────────────────────────────────────────────────');
    console.log('  건너뜀 — settings.json이 가리키는 PreToolUse 훅 파일이 아직 없다:');
    for (const h of missingHooks) console.log(`    ${h.command}`);
    console.log('  (다른 에이전트가 배선 중일 수 있다. 위 L1 감사에 FAIL로 기록됐다.)');
    console.log('');
  } else if (preToolHooks.length === 0) {
    console.log('── L2 판정 단언 ──────────────────────────────────────────────────────');
    console.log('  건너뜀 — PreToolUse 훅이 없다.');
    console.log('');
  } else {
    box = makeSandbox();
    for (const sc of SCENARIOS) {
      const phase = sc.effectivePhase || sc.phase || 'IDLE';
      writeState(box, sc.state || { phase: sc.phase });

      const filePath = sc.outside
        ? join(tmpdir(), 'outside-the-repo.ts')
        : sc.path
          ? join(box.dir, sc.path)
          : undefined;
      const payload = {
        session_id: 'hooks-selftest',
        transcript_path: join(box.dir, 'transcript.jsonl'),
        cwd: box.dir,
        hook_event_name: 'PreToolUse',
        tool_name: sc.tool,
        tool_input: sc.tool === 'Bash' ? { command: sc.cmd } : { file_path: filePath, content: '// 자기검사 합성 페이로드 — 한글 포함\n' },
      };
      const stdin = sc.malformed ? '{ this is not json, 한글 }' : JSON.stringify(payload);

      let decision = 'allow';
      let worstExit = 0;
      const logs = [];
      for (const h of preToolHooks) {
        if (!matcherHits(h.matcher, sc.tool)) continue;
        const tk = tokenize(h.command);
        const t0 = Date.now();
        const res = spawnSync(tk[0], tk.slice(1), { cwd: box.dir, input: stdin, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const ms = Date.now() - t0;
        maxMs = Math.max(maxMs, ms);
        const d = res.error ? 'error' : decisionOf(res);
        if (RANK[d] > RANK[decision]) decision = d;
        if (res.status) worstExit = res.status;
        logs.push({ command: h.command, ms, status: res.status, decision: d, stderr: (res.stderr || '').trim(), stdout: (res.stdout || '').trim() });
      }

      // warn_only 유예 반영: 정책 의도가 deny여도 유예 단계면 경고만 나오는 것이 정상이다
      const relaxed = sc.intent === 'deny' && WARN_ONLY.has(phase);
      const expect = relaxed ? 'warn' : sc.intent;
      const ok = sc.expectExit !== undefined ? worstExit === sc.expectExit && decision !== 'error' : decision === expect;

      results.push({ ...sc, phase, expect, relaxed, decision, ok, logs });
    }
  }
}

// ── 출력: 판정 단언 ─────────────────────────────────────────────────────────
if (results.length) {
  console.log('── L2 판정 단언 (합성 페이로드 → 실제 훅 실행) ───────────────────────');
  console.log(`  샌드박스: ${box.dir}`);
  console.log(`  enforce.warn_only = [${[...WARN_ONLY].join(', ')}]  ← 이 단계의 deny 기대값은 warn으로 완화된다`);
  console.log('');
  console.log('  결과  ID    단계      도구   기대    실제    시나리오');
  for (const r of results) {
    const target = r.cmd ? r.cmd : r.outside ? '(저장소 밖)' : r.malformed ? '(깨진 stdin)' : r.path;
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.phase.padEnd(8)} ${r.tool.padEnd(6)} ${r.expect.padEnd(6)}${r.relaxed ? '*' : ' '} ${r.decision.padEnd(6)} ${target}`
    );
    if (!r.ok || VERBOSE) {
      console.log(`        의도: ${r.why}`);
      for (const l of r.logs) {
        console.log(`        ${l.command}  exit=${l.status} ${l.ms}ms → ${l.decision}`);
        if (l.stderr) console.log(`          stderr: ${l.stderr.split('\n')[0].slice(0, 150)}`);
        if (l.stdout && VERBOSE) console.log(`          stdout: ${l.stdout.slice(0, 150)}`);
      }
    }
  }
  console.log('');
  console.log('  * = enforce.warn_only 유예가 적용된 기대값 (block 전환 시 deny가 된다)');
  console.log(`  훅 최대 응답 ${maxMs}ms — gate_phase.py의 자체 예산은 150ms다 (느린 게이트는 꺼지는 게이트다)`);
  if (maxMs > 400) {
    warn(
      `훅 응답이 ${maxMs}ms까지 걸렸다 (예산 150ms)`,
      '게이트가 서브프로세스를 띄우고 있지 않은지 확인하라. 가드 실행은 phase.py enter 쪽에만 있어야 한다.'
    );
  }
  console.log('');

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    const kind = r.must ? '필수 단언' : '단언';
    fail(
      `${kind} ${r.id} 실패 — ${r.phase}/${r.tool} 기대 ${r.expect}, 실제 ${r.decision}`,
      r.decision === 'allow'
        ? `게이트가 통과시켰다. ${r.why}. harness/policy/phase-matrix.json의 phases.${r.phase} write_allow/write_deny와 훅의 경로 매칭을 확인하라 (node scripts/policy-lint.mjs).`
        : r.decision === 'error'
          ? `훅이 오류로 죽었다(exit≠0,2). 죽은 훅은 fail-open이다 — Claude Code는 오류를 무시하고 도구를 실행한다. 위 stderr를 보라.`
          : `기대와 다른 판정이다. 정책이 틀렸는지(policy-lint) 훅 구현이 틀렸는지 가려라.`
    );
  }
}

// ── PostToolUse / Stop / SessionStart: 실행하지 않는 이유를 밝힌다 ──────────
const notRun = hooks.filter((h) => h.event !== 'PreToolUse');
if (notRun.length && !AUDIT_ONLY) {
  console.log('── 실행하지 않은 훅 (L1 감사만 적용) ─────────────────────────────────');
  for (const h of notRun) console.log(`  ${h.event.padEnd(14)} ${h.command}`);
  console.log('  이유: 이 훅들은 판정(allow/deny)을 내지 않는다. PostToolUse는 전체 검증 파이프라인을');
  console.log('  호출하므로 여기서 실행하면 자기검사가 느려지고, 무엇보다 **현재 워킹트리의 건강 상태에');
  console.log('  결과가 좌우된다** — 남의 코드가 깨져 있으면 게이트 자기검사가 빨개진다. 그건 다른 센서의 일이다.');
  console.log('');
}

if (box && !KEEP) rmSync(box.dir, { recursive: true, force: true });
else if (box) console.log(`  샌드박스 보존: ${box.dir}`);

// ── 요약 ────────────────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');
if (findings.length) {
  console.log('── 지적 ──────────────────────────────────────────────────────────────');
  for (const f of findings) {
    console.log(`${f.level} ${f.what}`);
    console.log(`     고치는 법: ${f.how}`);
  }
  console.log('');
}

const passed = results.filter((r) => r.ok).length;
console.log(`요약: 훅 ${hooks.length}개 · 판정 단언 ${passed}/${results.length} 통과 · FAIL ${fails.length} · WARN ${warns.length}`);
if (fails.length) {
  console.log('훅 자기검사 실패. 게이트가 작동한다는 증거가 없는 상태다 — 이 상태로 머지하면 경계면은 장식이다.');
  process.exit(1);
}
console.log('훅 자기검사 통과 — 게이트가 실제로 allow/deny를 내는 것이 실증됐다.');
process.exit(0);
