#!/usr/bin/env node
/**
 * scripts/check.mjs — 검증 단일 구현체.
 *
 * check.sh / CI / hook / 전이 가드가 전부 이 파일 하나를 부른다.
 * 의존성 없음(node: 내장 모듈만), 셸 없음, 절대경로 없음 — Windows·ubuntu 동일 동작.
 *
 *   --fast              변경·미추적 TS 파일만 lint. hook 경로, 예산 5초 (ADR-0005 결정5)
 *   (인자 없음)          eslint . → tsc --noEmit → vitest run. CI 게이트, 예산 3분
 *   --red --rq RQ-XX    ADR-0005 결정3 Red 정당성 판정
 *   --repeat N          테스트 스위트 N회 반복 — flake 보정용 시그니처 수집
 *   --help              사용법
 *
 * 종료 코드는 계약이다: 0 = 통과, 그 외 = 실패.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 프로젝트 루트는 process.cwd()가 아니라 이 스크립트 위치에서 유도한다 —
// hook·CI·서브셸이 어디서 부르든 같은 곳을 본다.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** --fast가 린트할 확장자. `.tsx` 누락이 클라이언트 전체를 무검사로 방치했었다. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
/** ADR-0005 결정5: hook 경로 예산. 초과해도 실패시키지 않고 경고만 한다. */
const FAST_BUDGET_MS = 5000;
/** ADR-0005 결정3: 아직 만들지 않은 src/ 모듈 임포트만이 정당한 Red다. */
const LEGIT_RED_TS_CODES = new Set(['TS2307', 'TS2305']);
/** tsc가 모듈을 찾을 때 시도하는 확장자 — TS2307 대상이 실재하는지 확인용. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx'];

// ── 공통 유틸 ────────────────────────────────────────────────────────────────

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

/** 실패는 항상 "어떻게 고치는지"와 함께 나간다 (harness/sensor-catalog.md 운영규칙 2). */
function die(message, howToFix, code = 1) {
  console.error('');
  console.error(`✗ ${message}`);
  for (const line of toArray(howToFix)) console.error(`  → ${line}`);
  process.exit(code);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function toRelative(absOrMixed) {
  return toPosix(path.relative(projectRoot, absOrMixed)) || absOrMixed;
}

function firstLine(text) {
  if (!text) return '';
  return String(text).split(/\r?\n/).find((l) => l.trim()) ?? '';
}

/**
 * node_modules의 패키지 매니페스트에서 JS 진입점을 찾는다.
 * `npx`·`node_modules/.bin` 셸 shim을 거치지 않는 이유: Windows의 .cmd shim은
 * spawn에 shell:true를 요구하고, 그 순간 인용 규칙이 플랫폼별로 갈린다.
 */
function resolveBin(pkg, binName = pkg) {
  const manifestPath = path.join(projectRoot, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (!rel) return null;
  const abs = path.join(projectRoot, 'node_modules', pkg, rel);
  return fs.existsSync(abs) ? abs : null;
}

function requireBin(pkg, binName = pkg) {
  const bin = resolveBin(pkg, binName);
  if (!bin) {
    die(`${pkg} 실행 파일을 찾을 수 없습니다 (node_modules/${pkg}).`, [
      'npm ci    # 의존성을 설치한 뒤 다시 실행하세요',
      `설치했는데도 같은 오류면 package.json의 devDependencies에 ${pkg}가 있는지 확인하세요.`,
    ]);
  }
  return bin;
}

/** 도구를 node로 직접 실행한다 — 셸 없음. */
function runNode(binPath, args, { capture = false, extraEnv } = {}) {
  const res = spawnSync(process.execPath, [binPath, ...args], {
    cwd: projectRoot,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (res.error) {
    die(`${toRelative(binPath)} 실행 실패: ${res.error.message}`, [
      'node --version 으로 Node >= 22 인지 확인하고, npm ci 로 의존성을 재설치하세요.',
    ]);
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** git 조회 전용 — 실패(저장소 아님·커밋 없음)는 null로 삼키고 호출부가 빈 목록으로 처리한다. */
function git(args) {
  const res = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

function hasNodeModules() {
  return fs.existsSync(path.join(projectRoot, 'node_modules'));
}

// ── 모드: --fast ─────────────────────────────────────────────────────────────

function changedTypeScriptFiles() {
  const tracked = git(['diff', '--name-only', 'HEAD']) ?? '';
  const untracked = git(['ls-files', '--others', '--exclude-standard']) ?? '';
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/))]
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => TS_EXTENSIONS.has(path.extname(file)))
    // 삭제된 파일도 git diff에 뜬다 — 실재하는 것만 린트한다.
    .filter((file) => fs.existsSync(path.join(projectRoot, file)))
    .sort();
}

function modeFast() {
  // 클론 직후 등 node_modules 부재 시 조용히 통과 — 환경 문제는 전체 검증이 잡는다.
  if (!hasNodeModules()) return 0;

  const files = changedTypeScriptFiles();
  if (files.length === 0) return 0;

  const startedAt = Date.now();
  const { code } = runNode(requireBin('eslint'), ['--cache', '--no-warn-ignored', ...files]);
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > FAST_BUDGET_MS) {
    console.error(
      `⚠ --fast ${(elapsedMs / 1000).toFixed(1)}초 — ADR-0005 결정5의 5초 예산 초과 ` +
        `(대상 ${files.length}개). .eslintcache를 지웠거나 변경 파일이 과다합니다.`,
    );
  }

  if (code !== 0) {
    const sample = files.slice(0, 3).join(' ') + (files.length > 3 ? ' …' : '');
    die(`린트 실패 — 변경된 TS 파일 ${files.length}개 중 위반 있음`, [
      `npx eslint --fix ${sample}    # 자동 수정 가능한 규칙부터 처리`,
      '남는 오류는 위에 찍힌 파일:줄:열 위치를 직접 고치세요.',
      '규칙 자체가 틀렸다고 판단되면 eslint.config.js 변경은 ADR이 필요합니다 (CLAUDE.md).',
    ], code);
  }
  return 0;
}

// ── 모드: 인자 없음 (전체 검증 = CI 게이트) ──────────────────────────────────

function modeFull() {
  const steps = [
    {
      label: 'lint',
      command: 'eslint .',
      bin: () => requireBin('eslint'),
      args: ['.'],
      fix: [
        'npx eslint . --fix    # 자동 수정 가능한 규칙부터 처리',
        '남는 오류는 위에 찍힌 파일:줄:열 위치를 직접 고치세요.',
      ],
    },
    {
      label: 'typecheck',
      command: 'tsc --noEmit',
      bin: () => requireBin('typescript', 'tsc'),
      args: ['--noEmit'],
      fix: [
        'npx tsc --noEmit    # 전체 오류 목록 재확인',
        '"Cannot find module ../src/…"만 남았다면 구현이 아직 없는 Red 상태입니다 — node scripts/check.mjs --red --rq RQ-XX 로 정당성을 판정하세요.',
        '그 외 오류는 타입을 좁히거나 시그니처를 맞추세요. any 캐스팅으로 덮지 마세요.',
      ],
    },
    {
      label: 'test',
      command: 'vitest run',
      bin: () => requireBin('vitest'),
      args: ['run'],
      fix: [
        'npx vitest run <파일경로>    # 실패한 파일만 좁혀서 재현',
        'node scripts/check.mjs --repeat 5    # 재현되지 않으면 flake인지 먼저 판별',
        '실패 테스트를 skip·삭제로 "해결"하는 것은 금지입니다 (CLAUDE.md).',
      ],
    },
  ];

  for (const [index, step] of steps.entries()) {
    console.log(`\n▶ ${index + 1}/${steps.length} ${step.label}  (${step.command})`);
    const { code } = runNode(step.bin(), step.args);
    if (code !== 0) {
      die(`${step.label} 실패 (${step.command}, exit ${code})`, step.fix, code);
    }
  }

  console.log('\n✓ lint + typecheck + test 전부 통과');
  return 0;
}

// ── vitest 리포트 파싱 ───────────────────────────────────────────────────────

function withTempReport(fn) {
  const file = path.join(os.tmpdir(), `bvwebchat-vitest-${process.pid}-${Date.now()}.json`);
  try {
    return fn(file);
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 임시 파일 정리 실패가 검증 결과를 바꿔선 안 된다.
    }
  }
}

/**
 * vitest를 돌리고 JSON 리포트를 파싱한다.
 * `--reporter=json`을 stdout으로 받지 않고 파일로 받는 이유: 워커 크래시 시
 * stdout에 JSON이 아닌 것이 섞여 파싱이 통째로 실패한다.
 */
function runVitest({ live }) {
  return withTempReport((reportFile) => {
    const reporters = live ? ['--reporter=default', '--reporter=json'] : ['--reporter=json'];
    const res = runNode(requireBin('vitest'), ['run', ...reporters, `--outputFile=${reportFile}`], {
      capture: !live,
    });
    let report = null;
    if (fs.existsSync(reportFile)) {
      try {
        report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      } catch {
        report = null;
      }
    }
    return { ...res, report };
  });
}

/**
 * 실패 단위를 세 모집단으로 나눈다 (00_approved-plan.md §5 검증 프로토콜).
 *   assert  — 단언 실패 (진짜 회귀 후보)
 *   collect — 파일이 로드조차 안 됨 (그린필드 Red의 정상 형태)
 *   crash   — 프로세스는 실패했는데 보고된 실패가 0건 (워커 크래시)
 */
function collectFailures(report, exitCode) {
  const failures = [];
  for (const suite of report?.testResults ?? []) {
    const file = toRelative(suite.name);
    const assertions = suite.assertionResults ?? [];
    let sawFailedAssertion = false;
    for (const assertion of assertions) {
      if (assertion.status !== 'failed') continue;
      sawFailedAssertion = true;
      failures.push({
        kind: 'assert',
        file,
        name: assertion.fullName || assertion.title || file,
        message: firstLine(assertion.failureMessages?.[0]),
      });
    }
    if (suite.status === 'failed' && !sawFailedAssertion) {
      failures.push({ kind: 'collect', file, name: file, message: firstLine(suite.message) });
    }
  }

  if (failures.length === 0 && exitCode !== 0) {
    const total = report?.numTotalTests ?? 0;
    const accounted = (report?.numPassedTests ?? 0) + (report?.numFailedTests ?? 0);
    const missing = Math.max(0, total - accounted);
    failures.push({
      kind: 'crash',
      file: '(프로세스)',
      name: `vitest exit=${exitCode}`,
      message: missing > 0 ? `테스트 ${missing}건이 실행되지 않음 (워커 크래시 추정)` : '보고된 테스트 실패 없이 비정상 종료',
    });
  }
  return failures;
}

/** 실행 간 비교가 가능하도록 절대경로·공백을 정규화한 시그니처. */
function signatureOf(failure) {
  const message = failure.message
    .replaceAll(toPosix(projectRoot), '<root>')
    .replaceAll(projectRoot, '<root>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${failure.kind}:${failure.file} :: ${failure.name}${message ? ` :: ${message}` : ''}`;
}

// ── tsc 출력 분류 (ADR-0005 결정3) ───────────────────────────────────────────

const TSC_ERROR_LINE = /^(.*?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

function parseTscErrors(output) {
  const errors = [];
  for (const line of output.split(/\r?\n/)) {
    const match = TSC_ERROR_LINE.exec(line.trim());
    if (match) {
      errors.push({ file: toPosix(match[1]), line: Number(match[2]), code: match[4], message: match[5] });
      continue;
    }
    // 파일 위치가 없는 오류(설정 오류 등)도 놓치지 않는다.
    const bare = /^error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
    if (bare) errors.push({ file: '(tsconfig)', line: 0, code: bare[1], message: bare[2] });
  }
  return errors;
}

function moduleSpecifierOf(error) {
  if (error.code === 'TS2307') {
    return /Cannot find module '([^']+)'/.exec(error.message)?.[1] ?? null;
  }
  if (error.code === 'TS2305') {
    return /Module '"([^"]+)"' has no exported member/.exec(error.message)?.[1] ?? null;
  }
  return null;
}

/** 임포트 대상이 아직 존재하지 않는 src/ 모듈인가. */
function targetsUnimplementedSrcModule(error) {
  const specifier = moduleSpecifierOf(error);
  // 상대 경로만 인정한다. 베어 스펙(패키지명)이면 의존성 누락이지 Red가 아니다.
  if (!specifier || !specifier.startsWith('.')) return false;

  const fromDir = path.dirname(path.resolve(projectRoot, error.file));
  const resolved = path.resolve(fromDir, specifier);
  const relativeToSrc = path.relative(path.join(projectRoot, 'src'), resolved);
  if (relativeToSrc.startsWith('..') || path.isAbsolute(relativeToSrc)) return false;

  // TS2305는 파일이 있고 export만 없는 경우 — 존재 검사를 하지 않는다.
  if (error.code === 'TS2305') return true;

  const exists = MODULE_EXTENSIONS.some(
    (ext) => fs.existsSync(resolved + ext) || fs.existsSync(path.join(resolved, `index${ext}`)),
  );
  return !exists;
}

function classifyTscErrors(errors) {
  const legitimate = [];
  const brokenTest = [];
  const other = [];
  for (const error of errors) {
    if (LEGIT_RED_TS_CODES.has(error.code) && targetsUnimplementedSrcModule(error)) {
      legitimate.push(error);
    } else if (/^tests?\//.test(error.file)) {
      brokenTest.push(error);
    } else {
      other.push(error);
    }
  }
  return { legitimate, brokenTest, other };
}

// ── 모드: --red --rq RQ-XX ───────────────────────────────────────────────────

function rqMatchers(rawId) {
  const id = rawId.trim().toUpperCase();
  const variants = new Set([id]);
  const parts = /^RQ-?(\d+)$/.exec(id);
  if (parts) {
    const n = Number(parts[1]);
    variants.add(`RQ-${String(n).padStart(2, '0')}`);
    variants.add(`RQ-${n}`);
  }
  return [...variants];
}

function matchesRq(text, variants) {
  const haystack = String(text).toUpperCase();
  return variants.some((v) => haystack.includes(v));
}

function printList(title, lines) {
  if (lines.length === 0) return;
  console.log(`\n${title}`);
  for (const line of lines) console.log(`  ${line}`);
}

function modeRed(rqId) {
  const variants = rqMatchers(rqId);
  console.log(`\n▶ Red 판정: ${variants[0]} (ADR-0005 결정3)`);
  console.log(`  대상 토큰: ${variants.join(' | ')}`);

  console.log('\n▶ 1/2 vitest run');
  const vitest = runVitest({ live: true });
  const failures = collectFailures(vitest.report, vitest.code);
  const rqFailures = failures.filter(
    (f) => matchesRq(f.name, variants) || matchesRq(f.file, variants),
  );

  console.log('\n▶ 2/2 tsc --noEmit');
  const tsc = runNode(requireBin('typescript', 'tsc'), ['--noEmit'], { capture: true });
  const tscErrors = parseTscErrors(`${tsc.stdout}\n${tsc.stderr}`);
  const { legitimate, brokenTest, other } = classifyTscErrors(tscErrors);

  console.log('\n── 판정 근거 ──────────────────────────────────────────────');
  printList(
    `(a) ${variants[0]}에 해당하는 실패 ${rqFailures.length}건`,
    rqFailures.map((f) => `[${f.kind}] ${f.file} :: ${f.name}${f.message ? ` — ${f.message}` : ''}`),
  );
  if (rqFailures.length === 0) {
    console.log(`\n(a) ${variants[0]}에 해당하는 실패 0건`);
  }
  const unrelated = failures.length - rqFailures.length;
  if (unrelated > 0) {
    printList(
      `(참고) ${variants[0]}와 무관한 실패 ${unrelated}건`,
      failures
        .filter((f) => !rqFailures.includes(f))
        .map((f) => `[${f.kind}] ${f.file} :: ${f.name}`),
    );
  }
  printList(
    `(b) 정당한 tsc 오류 ${legitimate.length}건 (미구현 src/ 모듈 임포트)`,
    legitimate.map((e) => `${e.code} ${e.file}:${e.line} — ${e.message}`),
  );
  printList(
    `(b) 테스트 파일 자체의 타입 오류 ${brokenTest.length}건 → 깨진 테스트`,
    brokenTest.map((e) => `${e.code} ${e.file}:${e.line} — ${e.message}`),
  );
  printList(
    `(b) 그 외 타입 오류 ${other.length}건`,
    other.map((e) => `${e.code} ${e.file}:${e.line} — ${e.message}`),
  );
  console.log('');

  if (brokenTest.length > 0) {
    die(
      `Red 아님 — 테스트 파일 자체에 타입 오류 ${brokenTest.length}건 (깨진 테스트)`,
      [
        'ADR-0005 결정3: 테스트 파일 로직·목 시그니처의 타입 오류는 Red로 인정하지 않습니다.',
        '위 tests/ 경로의 오류를 test-writer가 먼저 고쳐야 합니다 (구현 코드는 아직 건드리지 마세요).',
        '실제 사례: RQ-01의 `disconnect(): this` 목 시그니처 버그가 vitest만 돌린 Red를 통과했습니다.',
      ],
      3,
    );
  }

  if (other.length > 0) {
    die(
      `Red 아님 — TS2307/TS2305가 아닌 타입 오류 ${other.length}건`,
      [
        'ADR-0005 결정3은 "아직 만들지 않은 src/ 모듈 임포트"(TS2307/TS2305)만 정당한 Red로 인정합니다.',
        '위 오류를 먼저 해소한 뒤 다시 판정하세요: node scripts/check.mjs --red --rq ' + variants[0],
      ],
      4,
    );
  }

  if (rqFailures.length === 0) {
    die(
      `Red 아님 — ${variants[0]} 이름을 가진 실패 테스트가 0건`,
      [
        `${variants[0]}를 검증하는 테스트를 먼저 작성하세요. 테스트 이름에 RQ-ID를 포함해야 합니다 (ADR-0005 결정2).`,
        '테스트를 이미 썼다면 vitest include 패턴(tests/**/*.test.ts|tsx)에 맞는 경로인지 확인하세요.',
        '테스트가 이미 통과 중이라면 그 요구사항은 Red가 아닙니다 — 다음 단계로 넘어가세요.',
      ],
      5,
    );
  }

  console.log(
    `✓ 정당한 Red — ${variants[0]} 실패 ${rqFailures.length}건, ` +
      `tsc 오류는 미구현 src/ 모듈 ${legitimate.length}건에 국한`,
  );
  return 0;
}

// ── 모드: --repeat N ─────────────────────────────────────────────────────────

function modeRepeat(times) {
  console.log(`\n▶ 테스트 스위트 ${times}회 반복 (flake 보정 — vitest run만 반복한다)`);
  const runs = [];
  const signatureCounts = new Map();

  for (let i = 1; i <= times; i += 1) {
    const startedAt = Date.now();
    const result = runVitest({ live: false });
    const elapsedMs = Date.now() - startedAt;
    const failures = collectFailures(result.report, result.code);
    const signatures = failures.map(signatureOf);
    for (const signature of signatures) {
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
    const passed = result.code === 0 && failures.length === 0;
    runs.push({ index: i, passed, elapsedMs, signatures, stderr: result.stderr });

    const verdict = passed ? 'PASS' : 'FAIL';
    console.log(
      `  run ${String(i).padStart(2)}/${times}  ${verdict}  ${(elapsedMs / 1000).toFixed(1)}s` +
        (passed ? '' : `  (${signatures.length}건)`),
    );
    for (const signature of signatures) console.log(`      ${signature}`);
    if (!passed && result.stderr.trim()) {
      console.log(`      stderr: ${firstLine(result.stderr).slice(0, 160)}`);
    }
  }

  const passCount = runs.filter((r) => r.passed).length;
  const failCount = times - passCount;
  console.log('\n── 요약 ───────────────────────────────────────────────────');
  console.log(`  통과 ${passCount}/${times} · 실패 ${failCount}/${times} · 실패율 ${((failCount / times) * 100).toFixed(0)}%`);
  const totalMs = runs.reduce((sum, r) => sum + r.elapsedMs, 0);
  console.log(`  1회 평균 ${(totalMs / times / 1000).toFixed(1)}s · 총 ${(totalMs / 1000).toFixed(1)}s`);

  if (signatureCounts.size > 0) {
    console.log('\n  실패 시그니처 (빈도순):');
    for (const [signature, count] of [...signatureCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(2)}회  ${signature}`);
    }
  }
  console.log('');

  if (failCount > 0) {
    die(`${times}회 중 ${failCount}회 실패`, [
      'crash: 시그니처만 나왔다면 워커 크래시(단언 diff 없음) — 코드 회귀가 아닐 수 있습니다. 이 값을 baseline으로 기록하세요.',
      'assert: 시그니처가 있으면 진짜 회귀입니다 — 해당 파일을 좁혀 재현하세요: npx vitest run <파일경로>',
      '여러 fake-timer 테스트가 동시에 timeout이면 타이머 규칙 위반(별개 모집단)입니다 — ADR-0005 결정4를 확인하세요.',
    ], 1);
  }

  console.log(`✓ ${times}회 전부 통과 — 이 구간에서 flake 없음`);
  return 0;
}

// ── 인자 처리 ────────────────────────────────────────────────────────────────

const USAGE = `사용법: node scripts/check.mjs [모드]

  (인자 없음)          전체 검증: eslint . → tsc --noEmit → vitest run  (CI 게이트)
  --fast              변경·미추적 .ts/.tsx/.mts/.cts만 lint  (hook, 예산 5초)
  --red --rq RQ-XX    ADR-0005 결정3 Red 정당성 판정
  --repeat N          테스트 스위트 N회 반복 — flake 시그니처 수집
  --help              이 도움말

종료 코드: 0 통과 · 1 일반 실패 · 2 잘못된 인자 · 3 깨진 테스트 · 4 부적격 타입 오류 · 5 실패 테스트 없음`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  if (argv.length === 0) return modeFull();

  if (argv[0] === '--fast') {
    if (argv.length > 1) {
      console.error(`✗ --fast는 추가 인자를 받지 않습니다: ${argv.slice(1).join(' ')}\n\n${USAGE}`);
      return 2;
    }
    return modeFast();
  }

  if (argv[0] === '--red') {
    const rqIndex = argv.indexOf('--rq');
    const rqId = rqIndex === -1 ? null : argv[rqIndex + 1];
    if (!rqId || !/^RQ-?\d+$/i.test(rqId)) {
      console.error(`✗ --red 에는 --rq RQ-XX 가 필요합니다 (예: --red --rq RQ-07)\n\n${USAGE}`);
      return 2;
    }
    return modeRed(rqId);
  }

  if (argv[0] === '--repeat') {
    const times = Number(argv[1]);
    if (!Number.isInteger(times) || times < 1 || times > 100) {
      console.error(`✗ --repeat 에는 1~100 사이 정수가 필요합니다 (예: --repeat 10)\n\n${USAGE}`);
      return 2;
    }
    return modeRepeat(times);
  }

  console.error(`✗ 알 수 없는 인자: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
