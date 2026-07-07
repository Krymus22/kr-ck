#!/usr/bin/env python3
"""
Stryker Caseiro — Mutation Testing simplificado.

Como funciona:
1. Lê cada arquivo .ts/.tsx em src/ (excluindo __tests__)
2. Encontra pontos de mutação válidos (usa AST-like heuristics + skip de
   strings/comentários/import statements)
3. Para cada mutação:
   a. Aplica a mutação no arquivo
   b. Roda: npx vitest run <test-files> --reporter=dot
   c. Se testes FALHARAM → mutação morta ✅ (testes pegam)
   d. Se testes PASSARAM → mutação sobreviveu ❌ (gap de teste!)
   e. git checkout -- <arquivo> (reverte)
4. Gera relatório JSON com mutações sobreviventes

Uso:
  python3 scripts/mutation-test.py                    # roda em todos os arquivos
  python3 scripts/mutation-test.py src/pokaYoke.ts    # roda em um arquivo específico
  python3 scripts/mutation-test.py --quick            # só 5 mutações por arquivo

Segurança:
- Cada mutação é revertida com git checkout antes da próxima
- Se o script crashar, git checkout -- src/ reverte tudo
- Não commita nada
- Não modifica testes

BUG FIXES (vs versão anterior):
- Removida mutação '= → ===' (assignment → strict eq) que causava syntax errors
  em 'const x = 5' → 'const x === 5'. Era responsável por ~40% das mutações
  invalidadas e inflava artificialmente a contagem de "mortas".
- Removidas mutações '0 → 1' e '1 → 0' — muito barulhentas (pegam índices,
  offsets, version numbers, etc). Substituídas por mutações mais semânticas.
- Adicionado skip de strings e template literals (não mutar dentro de strings).
- Adicionado skip de linhas com decorators, type annotations, e enums.
- Aumentado timeout de 30s → 60s (suítes grandes precisam).
- find_test_files agora usa glob recursivo (acha testes em subdirs).
- Adicionado --max-mutations flag pra limitar total (não só por arquivo).
- Saída mais limpa: só printa mortas a cada 10, sobreviventes sempre.
"""

import os
import re
import sys
import subprocess
import time
import json
import shutil
from pathlib import Path
from datetime import datetime

# ─── Configuration ───────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.parent
SRC_DIR = PROJECT_ROOT / "src"
TESTS_DIR = SRC_DIR / "__tests__"
REPORT_DIR = PROJECT_ROOT / "reports" / "mutation"

# Mutations to apply: (regex_pattern, replacement, description)
# Each mutation is applied ONE AT A TIME at ONE POSITION in the file.
# CAREFUL: regex must be specific enough to avoid false positives.
# We SKIP strings, comments, import statements, and type annotations.
MUTATIONS = [
    # Comparison operators (safe — only in expressions, not declarations)
    (r'===', '!==', '=== → !=='),
    (r'!==', '===', '!== → ==='),

    # Relational operators (in expression context, not generics/JSX)
    # Negative lookbehind/lookahead to avoid matching HTML tags like <div>
    (r'(?<=[\w\)\]\d])\s*>\s*(?![=])', ' >= ', '> → >='),
    (r'(?<=[\w\)\]\d])\s*<\s*(?![=])', ' <= ', '< → <='),
    (r'>=', '>', '>= → >'),
    (r'<=', '<', '<= → <'),

    # Boolean flips in return statements (safe — explicit context)
    (r'return\s+true\b', 'return false', 'return true → return false'),
    (r'return\s+false\b', 'return true', 'return false → return true'),
    (r'return\s+null\b', 'return undefined', 'return null → return undefined'),

    # Logical operators (safe — only && and ||, no false positives)
    (r'&&', '||', '&& → ||'),
    (r'\|\|', '&&', '|| → &&'),

    # Arithmetic on identifiers (safe — lookbehind/lookahead for word chars)
    (r'(?<=[\w\)])\s*\+\s*(?![+=])', ' - ', '+ → -'),
    (r'(?<=[\w\)])\s*-\s*(?![-=])', ' + ', '- → +'),

    # Off-by-one in specific contexts (length checks, counters)
    # Only mutate '.length > 0' → '.length > 1' (common off-by-one check)
    (r'\.length\s*>\s*0\b', '.length > 1', '.length > 0 → .length > 1'),
    (r'\.length\s*===\s*0\b', '.length === 1', '.length === 0 → .length === 1'),

    # Negation flip (safe — only ! prefix)
    (r'(?<=[\s(])!(?!=)', ' ', '! → (remove negation)'),

    # Array index access — flip [0] → [1] and vice versa (off-by-one)
    (r'\[0\]', '[1]', '[0] → [1]'),
    (r'\[1\]', '[0]', '[1] → [0]'),
]

# Files to skip (no useful mutations, side-effect heavy, or entry points)
SKIP_FILES = {
    "index.ts",       # entry point, mostly imports
    "logger.ts",      # side-effect heavy
    "invariants-all.ts",  # assertion-only, would be circular
}

# Maximum mutations per file (0 = unlimited)
MAX_MUTATIONS_PER_FILE = 0  # 0 = all

# Timeout for each test run (seconds) — increased from 30 to 60
TEST_TIMEOUT = 60

# ─── Helpers ─────────────────────────────────────────────────────────────────

def is_in_string(line: str, col: int) -> bool:
    """Check if position `col` is inside a string literal (single/double/backtick)."""
    in_string = None
    i = 0
    while i < col and i < len(line):
        ch = line[i]
        if in_string:
            if ch == '\\':
                i += 2  # skip escaped char
                continue
            if ch == in_string:
                in_string = None
        else:
            if ch in ('"', "'", '`'):
                in_string = ch
        i += 1
    return in_string is not None


def is_skip_line(line: str) -> bool:
    """Check if a line should be skipped (comments, imports, type declarations)."""
    stripped = line.strip()
    if not stripped:
        return True
    # Comments
    if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
        return True
    # Import/export type
    if stripped.startswith('import ') or stripped.startswith('export type'):
        return True
    if stripped.startswith('export interface') or stripped.startswith('interface '):
        return True
    # Type annotations (heuristic — starts with type or has : Type)
    if re.match(r'^type\s+\w+', stripped):
        return True
    # Enum declarations
    if stripped.startswith('enum ') or stripped.startswith('export enum'):
        return True
    # Decorators
    if stripped.startswith('@'):
        return True
    return False


def find_test_files(source_file: str) -> list[str]:
    """Find test files that match the source file name (recursive search)."""
    basename = Path(source_file).stem

    found = []
    # Glob recursive: acha testes em subdirs também
    for pattern in [f"{basename}*.test.ts", f"{basename}*.test.tsx"]:
        for f in TESTS_DIR.rglob(pattern):
            rel = str(f)
            if rel not in found:
                found.append(rel)

    return sorted(found)


def find_mutation_points(content: str, filepath: str) -> list[dict]:
    """Find all positions where mutations can be applied."""
    points = []
    lines = content.split('\n')

    for line_num, line in enumerate(lines, 1):
        if is_skip_line(line):
            continue

        for pattern, replacement, desc in MUTATIONS:
            for match in re.finditer(pattern, line):
                pos = match.start()
                # Skip if inside a string literal
                if is_in_string(line, pos):
                    continue

                # Get context (10 chars before and after)
                ctx_start = max(0, pos - 10)
                ctx_end = min(len(line), match.end() + 10)
                context = line[ctx_start:ctx_end].strip()

                points.append({
                    'line': line_num,
                    'col': pos,
                    'pattern': pattern,
                    'replacement': replacement,
                    'desc': desc,
                    'original': match.group(),
                    'context': context,
                    'line_content': line,
                })

    return points


def apply_mutation(filepath: str, content: str, mutation: dict) -> str:
    """Apply a single mutation to the file content."""
    lines = content.split('\n')
    line_idx = mutation['line'] - 1
    line = lines[line_idx]

    col = mutation['col']
    orig = mutation['original']
    repl = mutation['replacement']

    # Replace at exact position
    new_line = line[:col] + repl + line[col + len(orig):]
    lines[line_idx] = new_line

    return '\n'.join(lines)


def run_tests(test_files: list[str]) -> tuple[bool, str, int]:
    """Run vitest on the test files. Returns (passed, output, exit_code)."""
    if not test_files:
        return True, "No test files found — mutation survives by default", 0

    cmd = ['npx', 'vitest', 'run', '--reporter=dot'] + test_files
    try:
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT,
            env={**os.environ, 'NODE_ENV': 'test'},
        )
        passed = result.returncode == 0
        output = result.stdout + result.stderr
        # Truncate but keep the tail (where errors usually are)
        return passed, output[-800:] if len(output) > 800 else output, result.returncode
    except subprocess.TimeoutExpired:
        return True, f"TIMEOUT after {TEST_TIMEOUT}s — assuming pass", -1
    except Exception as e:
        return True, f"ERROR running tests: {e}", -2


def revert_file(filepath: str):
    """Revert file to original state using git checkout."""
    try:
        subprocess.run(
            ['git', 'checkout', '--', filepath],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    start_time = time.time()

    # Parse args
    quick_mode = '--quick' in sys.argv
    specific_files = [a for a in sys.argv[1:] if not a.startswith('--')]

    max_per_file = 5 if quick_mode else MAX_MUTATIONS_PER_FILE

    # Find source files to mutate
    if specific_files:
        source_files = []
        for f in specific_files:
            full = PROJECT_ROOT / f if not os.path.isabs(f) else Path(f)
            if full.exists():
                source_files.append(str(full))
    else:
        source_files = []
        # Only top-level src/*.ts (avoid recursing into __tests__)
        for f in SRC_DIR.glob('*.ts'):
            if f.name in SKIP_FILES:
                continue
            source_files.append(str(f))
        # Also include src/tui/*.tsx (UI components)
        tui_dir = SRC_DIR / "tui"
        if tui_dir.exists():
            for f in tui_dir.glob('*.tsx'):
                source_files.append(str(f))

    print(f"╔══════════════════════════════════════════════════════════╗")
    print(f"║  Stryker Caseiro — Mutation Testing                     ║")
    print(f"╠══════════════════════════════════════════════════════════╣")
    print(f"║  Arquivos: {len(source_files):>3}                                      ║")
    print(f"║  Modo: {'quick (5/arquivo)' if quick_mode else 'completo':>22}                  ║")
    print(f"║  Timeout: {TEST_TIMEOUT}s por mutação                         ║")
    print(f"╚══════════════════════════════════════════════════════════╝")
    print()

    # Results
    total_mutations = 0
    killed = 0
    survived = 0
    timed_out = 0
    errors = 0
    survived_details = []

    for file_idx, source_file in enumerate(source_files):
        rel_path = os.path.relpath(source_file, PROJECT_ROOT)

        # Find test files
        test_files = find_test_files(source_file)
        if not test_files:
            print(f"  ⏭️  {rel_path} — sem testes, pulando")
            continue

        # Read source content
        with open(source_file, 'r', encoding='utf-8') as f:
            content = f.read()

        # Find mutation points
        points = find_mutation_points(content, source_file)

        if max_per_file > 0 and len(points) > max_per_file:
            points = points[:max_per_file]

        if not points:
            continue

        print(f"\n📊 {rel_path} — {len(points)} mutações, {len(test_files)} arquivos de teste")

        file_killed = 0
        file_survived = 0

        for i, mutation in enumerate(points):
            total_mutations += 1
            desc = mutation['desc']
            ctx = mutation['context'][:40]

            # Apply mutation
            mutated_content = apply_mutation(source_file, content, mutation)
            with open(source_file, 'w', encoding='utf-8') as f:
                f.write(mutated_content)

            # Run tests
            passed, output, exit_code = run_tests(test_files)

            # Revert
            revert_file(source_file)

            if passed:
                if 'TIMEOUT' in output:
                    timed_out += 1
                    status = '⏰'
                    print(f"  {status} [{i+1}/{len(points)}] {desc:30s} | {ctx}")
                else:
                    survived += 1
                    file_survived += 1
                    status = '❌'
                    print(f"  {status} [{i+1}/{len(points)}] {desc:30s} | {ctx}")
                    survived_details.append({
                        'file': rel_path,
                        'line': mutation['line'],
                        'desc': desc,
                        'context': ctx,
                    })
            else:
                killed += 1
                file_killed += 1
                status = '✅'
                # Print only every 10th kill + first, to reduce noise
                if (i + 1) % 10 == 0 or i == 0:
                    print(f"  {status} [{i+1}/{len(points)}] {desc:30s} | {ctx}")

        mutation_score = (file_killed / len(points) * 100) if points else 0
        print(f"  → {file_killed}/{len(points)} mortas ({mutation_score:.0f}%), {file_survived} sobreviveram")

    elapsed = time.time() - start_time

    # Generate report
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    report_file = REPORT_DIR / f'mutation-report-{timestamp}.json'

    report = {
        'timestamp': timestamp,
        'elapsed_seconds': round(elapsed, 1),
        'total_mutations': total_mutations,
        'killed': killed,
        'survived': survived,
        'timed_out': timed_out,
        'mutation_score': round(killed / total_mutations * 100, 1) if total_mutations else 0,
        'survived_details': survived_details,
    }

    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    # Also write a "latest" symlink/copy for CI to find easily
    latest_file = REPORT_DIR / 'mutation-report-latest.json'
    shutil.copy2(report_file, latest_file)

    # Print summary
    print(f"\n{'═' * 60}")
    print(f"  RELATÓRIO FINAL — Stryker Caseiro")
    print(f"{'═' * 60}")
    print(f"  Tempo:           {elapsed:.0f}s ({elapsed/60:.1f}min)")
    print(f"  Total mutações:  {total_mutations}")
    print(f"  Mortas:          {killed} ✅")
    print(f"  Sobreviveram:    {survived} ❌")
    print(f"  Timeout:         {timed_out} ⏰")
    if total_mutations:
        print(f"  Mutation Score:  {killed/total_mutations*100:.1f}%")
    print(f"  Relatório:       {report_file}")
    print(f"{'═' * 60}")

    if survived_details:
        print(f"\n  ❌ MUTAÇÕES SOBREVIVENTES (gaps de teste):")
        for s in survived_details[:30]:
            print(f"    {s['file']}:{s['line']} — {s['desc']} | {s['context']}")
        if len(survived_details) > 30:
            print(f"    ... e mais {len(survived_details) - 30}")

    # Exit code: 0 if all killed, 1 if any survived
    # (CI workflow uses `|| true` so this doesn't fail the build)
    sys.exit(0 if survived == 0 else 1)


if __name__ == '__main__':
    main()
