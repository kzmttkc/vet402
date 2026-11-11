"""README contract: every Python block compiles, and the offline sample runs with no network."""

from __future__ import annotations

import re
from pathlib import Path

README = Path(__file__).resolve().parent.parent / "README.md"
BLOCK_RE = re.compile(r"```python\n(.*?)```", re.S)


def _blocks() -> list[str]:
    return BLOCK_RE.findall(README.read_text(encoding="utf-8"))


def test_every_python_block_compiles() -> None:
    blocks = _blocks()
    assert len(blocks) >= 4
    for i, block in enumerate(blocks):
        compile(block, f"README.md python block {i}", "exec")


def test_offline_sample_reads_decision_through_mock_transport() -> None:
    sample = next(b for b in _blocks() if "MockTransport" in b)
    printed: list[tuple] = []
    namespace = {"print": lambda *args: printed.append(args)}
    exec(compile(sample, "README offline sample", "exec"), namespace)  # noqa: S102 - our own README
    assert printed == [("ALLOW",)]
    vouch = namespace["vouch"]
    assert vouch.get_payee_score("0x" + "ab" * 20)["recommendation"] == "ALLOW"


def test_readme_public_english_rules() -> None:
    text = README.read_text(encoding="utf-8")
    assert not re.search(r"\b(we|our|us)\b", text, re.I)
    assert "—" not in text and "–" not in text
    assert ";" not in text
    assert " . " not in text
