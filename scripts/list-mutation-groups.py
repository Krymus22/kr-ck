#!/usr/bin/env python3
"""
list-mutation-groups.py — Divide os arquivos de src/ em N grupos para
rodar mutation testing em paralelo no GitHub Actions (matrix strategy).

Uso:
  python3 scripts/list-mutation-groups.py <num_groups>
  python3 scripts/list-mutation-groups.py 20

Output: JSON array com N grupos, cada um sendo uma lista de caminhos de
arquivos relativos ao root do projeto.

Exemplo: python3 scripts/list-mutation-groups.py 3
  [["src/config.ts", "src/pokaYoke.ts"], ["src/effortLevels.ts"], ["src/session.ts"]]
"""

import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
SRC_DIR = PROJECT_ROOT / "src"
TUI_DIR = SRC_DIR / "tui"

SKIP_FILES = {"index.ts", "logger.ts", "invariants-all.ts"}
MAX_FILE_LINES = 1500


def collect_files():
    """Coleta todos os arquivos elegíveis para mutation testing."""
    files = []
    for f in sorted(SRC_DIR.glob("*.ts")):
        if f.name in SKIP_FILES:
            continue
        try:
            lc = sum(1 for _ in open(f, "r", encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        if lc > MAX_FILE_LINES:
            continue
        files.append(str(f.relative_to(PROJECT_ROOT)))
    if TUI_DIR.exists():
        for f in sorted(TUI_DIR.glob("*.tsx")):
            try:
                lc = sum(1 for _ in open(f, "r", encoding="utf-8", errors="ignore"))
            except Exception:
                continue
            if lc > MAX_FILE_LINES:
                continue
            files.append(str(f.relative_to(PROJECT_ROOT)))
    return files


def split_into_groups(files, num_groups):
    """Divide arquivos em N grupos, balanceando por contagem (não por tamanho)."""
    groups = [[] for _ in range(num_groups)]
    for i, f in enumerate(files):
        groups[i % num_groups].append(f)
    # Remove grupos vazios
    groups = [g for g in groups if g]
    return groups


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/list-mutation-groups.py <num_groups>", file=sys.stderr)
        sys.exit(1)

    num_groups = int(sys.argv[1])
    files = collect_files()
    groups = split_into_groups(files, num_groups)

    # Output JSON para o GitHub Actions consumir
    print(json.dumps(groups))


if __name__ == "__main__":
    main()
