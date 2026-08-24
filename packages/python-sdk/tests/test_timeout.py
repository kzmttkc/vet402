"""Timeout contract: the fail-closed chain must be reachable.

2026-08-22 (audit): the TypeScript SDK called ``fetch`` with no ``signal`` and
could hang an agent's payment path forever. The Python SDK was already bounded
(``httpx.Client(timeout=…)``), but nothing pinned that — a future refactor
passing ``timeout=None`` would silently reintroduce the same hole, and no
existing test would notice.

The invariant these tests hold: ``SpendGuard`` can only deny on a lookup that
RETURNS. A hung upstream produces neither an allow nor a deny, so the transport
must always convert "never answers" into an exception the guard can classify.
"""

from __future__ import annotations

import httpx
import pytest

from vet402 import (
    DEFAULT_TIMEOUT_SECONDS,
    SpendGuard,
    VouchClient,
    classify_lookup_failure,
    create_vouch_client,
)

from conftest import PAYEE


def test_default_timeout_is_ten_seconds_and_actually_reaches_httpx() -> None:
    # Matches the TypeScript SDK's DEFAULT_REQUEST_TIMEOUT_MS (10_000).
    # Deliberately NOT @vet402/middleware's 5s — see DEFAULT_TIMEOUT_SECONDS.
    assert DEFAULT_TIMEOUT_SECONDS == 10.0
    client = create_vouch_client("vk_test_key")
    # Asserted on the httpx client, not on the argument: the point is that the
    # bound is in force on the wire, not that it was passed somewhere.
    assert client._http.timeout == httpx.Timeout(10.0)  # noqa: SLF001 - contract check


def test_explicit_timeout_is_honoured() -> None:
    client = VouchClient("vk_test_key", timeout=0.25)
    assert client._http.timeout == httpx.Timeout(0.25)  # noqa: SLF001 - contract check


def test_a_timed_out_lookup_denies_as_payee_trust_unavailable() -> None:
    """A transport that times out must deny the payment, not raise at the caller."""

    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    client = VouchClient(
        "vk_test_key",
        api_url="https://vet402.test/api/v1",
        transport=httpx.MockTransport(hang),
    )
    guard = client.create_spend_guard(daily_budget_usd=100)

    decision = guard.evaluate(PAYEE, 10)

    assert decision.allow is False
    assert decision.reasons == ["payee_trust_unavailable"]
    assert decision.payee_score is None
    # The optimistic reservation comes back: a payment denied because the payee
    # could not be vetted never spent anything.
    assert guard.state()["spent_today_usd"] == 0
    assert decision.remaining_daily_budget_usd == 100


def test_a_timed_out_lookup_denies_under_block_only_too() -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    client = VouchClient(
        "vk_test_key",
        api_url="https://vet402.test/api/v1",
        transport=httpx.MockTransport(hang),
    )
    guard = client.create_spend_guard(trust_policy="block-only")

    decision = guard.evaluate(PAYEE, 5)

    assert decision.allow is False
    assert decision.reasons == ["payee_trust_unavailable"]


@pytest.mark.parametrize(
    "error",
    [
        httpx.ReadTimeout("read timed out"),
        httpx.ConnectTimeout("connect timed out"),
        httpx.PoolTimeout("pool timed out"),
        httpx.WriteTimeout("write timed out"),
    ],
)
def test_every_httpx_timeout_classifies_as_unavailable_not_unauthenticated(
    error: BaseException,
) -> None:
    # A timeout is an upstream problem, not a credential one: retrying may
    # help, so it must not be reported as "fix your key".
    assert classify_lookup_failure(error) == "payee_trust_unavailable"


def test_guard_never_hangs_when_the_fetcher_raises() -> None:
    """The guard itself must not swallow a transport failure into a pending state."""

    def always_times_out(_payee: str):
        raise httpx.ReadTimeout("timed out")

    guard = SpendGuard(always_times_out, max_per_tx_usd=50)
    decision = guard.evaluate(PAYEE, 1)
    assert decision.allow is False
    assert "payee_trust_unavailable" in decision.reasons
