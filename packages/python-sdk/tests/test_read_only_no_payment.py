"""Wave 1 §3.9: Python client stays read-only with no payment stack imports."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import httpx
import pytest

from vet402 import VouchClient

PKG_ROOT = Path(__file__).resolve().parent.parent
SRC = PKG_ROOT / "src" / "vet402"
README = PKG_ROOT / "README.md"
PYPROJECT = PKG_ROOT / "pyproject.toml"

FORBIDDEN_IMPORTS = (
    "eth_account",
    "web3",
    "eth_keys",
    "coincurve",
    "solana",
    "nacl",
)

FORBIDDEN_DEF_RE = re.compile(
    r"^\s*(?:async\s+)?def\s+(\w+)\s*\(",
    re.M,
)

FORBIDDEN_NAME_FRAGMENT = re.compile(
    r"\w*(?:sign|private_key|send_transaction)\w*",
    re.I,
)


def is_forbidden_payment_def(name: str) -> bool:
    lower = name.lower()
    if lower.startswith("pay_"):
        return True
    for frag in ("settle", "transfer", "execute_payment"):
        if frag in lower:
            return True
    return FORBIDDEN_NAME_FRAGMENT.fullmatch(name) is not None


def assert_no_payment_defs(text: str) -> None:
    for m in FORBIDDEN_DEF_RE.finditer(text):
        name = m.group(1)
        if is_forbidden_payment_def(name):
            raise AssertionError(f"forbidden def name: {name}")


def test_vet402_modules_avoid_payment_imports_and_sign_helpers() -> None:
    for path in sorted(SRC.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    assert root not in FORBIDDEN_IMPORTS, f"{path.name} imports {alias.name}"
            elif isinstance(node, ast.ImportFrom) and node.module:
                root = node.module.split(".")[0]
                assert root not in FORBIDDEN_IMPORTS, f"{path.name} imports from {node.module}"
        assert_no_payment_defs(text)


def test_forbidden_payment_def_names_fail_guard() -> None:
    samples = [
        "async def sign_payment():\n    pass\n",
        "def pay_now():\n    pass\n",
        "def settle():\n    pass\n",
    ]
    for sample in samples:
        with pytest.raises(AssertionError):
            assert_no_payment_defs(sample)


def test_get_payee_score_and_resource_decision_use_get_only(make_client) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/payees/" in request.url.path and request.url.path.endswith("/score"):
            return httpx.Response(
                200,
                json={
                    "payee": "0x" + "ab" * 20,
                    "score": 80,
                    "recommendation": "ALLOW",
                    "dataDepth": "moderate",
                    "degraded": False,
                    "signalsUnavailable": [],
                    "signals": {},
                    "scoredAt": "2026-01-01T00:00:00Z",
                    "cacheExpiresAt": "2026-01-01T00:05:00Z",
                    "disclaimer": "Informational only.",
                },
            )
        if request.url.path.endswith("/decision"):
            return httpx.Response(
                200,
                json={
                    "subject": {"type": "resource", "id": "res_1"},
                    "role": "payer",
                    "recommendation": "ALLOW",
                    "reason_codes": [],
                    "facts": {},
                    "evidence": [],
                    "degraded": False,
                    "policy": "allow_only",
                    "rules_version": "2026-01-01",
                },
            )
        raise AssertionError(f"unexpected path {request.url}")

    client, recorder = make_client(handler)
    client.get_payee_score("0x" + "ab" * 20)
    client.get_resource_decision("res_1")

    assert len(recorder.requests) == 2
    for req in recorder.requests:
        assert req.method == "GET"


def test_pyproject_version_and_readme_not_pypi_install() -> None:
    pyproject = PYPROJECT.read_text(encoding="utf-8")
    assert 'version = "0.1.0"' in pyproject
    readme = README.read_text(encoding="utf-8")
    assert "Not yet published to PyPI" in readme
    assert "pip install vet402-sdk" not in readme.lower()
