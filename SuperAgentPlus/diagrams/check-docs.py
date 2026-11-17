#!/usr/bin/env python3
"""检查 SuperAgentPlusCloud 的设计文档与图示文件。

只做文件级检查：本地链接目标、UTF-8、表格列数、代码围栏、图示文件
存在性与摘要。不证明语义正确、系统实现或真实协作收益。
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "SuperAgentPlus"
REPORT = BASE / "diagrams" / "document-check.json"
DOCUMENTS = [
    "README.md",
    "01_定位与总体构想.md",
    "02_协作治理与生命周期.md",
    "03_系统架构与协作协议.md",
    "04_场景推演与协作体验.md",
    "05_MVP与设计验证路线.md",
    "06_工作契约与决策模板.md",
    "07_总工信息隔离.md",
    "08_云端与单机职责边界.md",
    "设计检查说明.md",
]
DIAGRAMS = ["architecture", "workflow"]
ABSOLUTE = re.compile(r"(?:^|[\\s(<])([A-Za-z]:[\\\\/]|/Users/|/home/)")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_markdown(path: Path):
    errors: list[str] = []
    targets: set[str] = set()
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return raw, "", targets, [f"{path.name}: not UTF-8 ({exc})"]
    if "\ufffd" in text:
        errors.append(f"{path.name}: replacement character")
    if not text.startswith("# "):
        errors.append(f"{path.name}: missing title")
    if sum(line.strip().startswith("```") for line in text.splitlines()) % 2:
        errors.append(f"{path.name}: unclosed code fence")
    if ABSOLUTE.search(text):
        errors.append(f"{path.name}: machine-absolute path")

    expected = None
    for no, line in enumerate(text.splitlines(), 1):
        if line.startswith("|") and line.rstrip().endswith("|"):
            cells = re.split(r"(?<!\\)\|", line.rstrip())[1:-1]
            if expected is None:
                expected = len(cells)
            elif len(cells) != expected:
                errors.append(f"{path.name}:{no}: table columns {len(cells)} != {expected}")
        else:
            expected = None

    definitions = dict(re.findall(r"^\[([^\]]+)\]:\s*<([^>]+)>\s*$", text, re.M))
    for key in re.findall(r"\[[^\]\n]+\]\[([^\]\n]+)\]", text):
        if key not in definitions:
            errors.append(f"{path.name}: missing reference {key}")

    destinations = list(definitions.values())
    destinations += re.findall(r"\[[^\]\n]+\]\(<([^>]+)>\)", text)
    destinations += re.findall(r"\[[^\]\n]+\]\(([^)<>\s]+)\)", text)
    for dest in dict.fromkeys(destinations):
        if dest.startswith(("https://", "http://", "mailto:")):
            continue
        target, _, fragment = dest.partition("#")
        if not target:
            continue
        if re.match(r"^[A-Za-z]:[\\\\/]", target) or target.startswith("/"):
            errors.append(f"{path.name}: machine-absolute link {dest}")
            continue
        local = (path.parent / target).resolve()
        targets.add(str(local))
        if local == REPORT.resolve():
            continue
        if not local.is_file():
            errors.append(f"{path.name}: missing target {dest}")
            continue
        if fragment:
            m = re.fullmatch(r"L(\d+)(?:-L(\d+))?", fragment)
            if m:
                first = int(m.group(1))
                last = int(m.group(2) or first)
                count = len(local.read_text(encoding="utf-8").splitlines())
                if not (1 <= first <= last <= count):
                    errors.append(f"{path.name}: invalid line range {dest}")

    return raw, text, targets, errors


def main() -> None:
    errors: list[str] = []
    documents = []
    targets: set[str] = set()
    for name in DOCUMENTS:
        path = BASE / name
        if not path.is_file():
            errors.append(f"missing document {name}")
            continue
        raw, _text, local_targets, doc_errors = check_markdown(path)
        errors.extend(doc_errors)
        targets |= local_targets
        documents.append(
            {
                "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                "bytes": len(raw),
                "lines": len(raw.decode("utf-8").splitlines()),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )

    diagrams = []
    for kind in DIAGRAMS:
        candidate = BASE / "diagrams" / kind / "candidate.json"
        artifact = BASE / "diagrams" / kind / f"{kind}.html"
        if not candidate.is_file():
            errors.append(f"{kind}: missing candidate.json")
        if not artifact.is_file():
            errors.append(f"{kind}: missing {kind}.html")
        if candidate.is_file() and artifact.is_file():
            diagrams.append(
                {
                    "type": kind,
                    "candidate": str(candidate.relative_to(ROOT)).replace("\\", "/"),
                    "candidate_sha256": sha256(candidate),
                    "artifact": str(artifact.relative_to(ROOT)).replace("\\", "/"),
                    "artifact_sha256": sha256(artifact),
                    "artifact_bytes": artifact.stat().st_size,
                }
            )

    result = {
        "status": "pass" if not errors else "fail",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "scope": "design documents and diagram files only; not implementation tests",
        "markdown_documents": documents,
        "local_link_targets_checked": len(targets),
        "diagrams": diagrams,
        "errors": errors,
        "limits": [
            "semantic correctness of citations requires manual review",
            "no CLI compatibility, concurrency, sandbox or user-study claim",
            "diagram browser/visual receipts are not included in this public repository",
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {"status": result["status"], "documents": len(documents), "diagrams": len(diagrams), "errors": errors},
            ensure_ascii=False,
        )
    )
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
