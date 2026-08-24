"""VouchClient: thin synchronous client for the vet402 Trust API.

Mirrors the TypeScript SDK (``@vet402/sdk``): same endpoints, same
validation, same error contract (:class:`~vet402.errors.VouchApiError` with
the API's machine-readable code plus HTTP status).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Union

import httpx

from .errors import VouchApiError
from .spend_guard import SpendGuard, SpendGuardTrustPolicy

__all__ = [
    "DEFAULT_API_URL",
    "DEFAULT_TIMEOUT_SECONDS",
    "VouchClient",
    "create_vouch_client",
]

#: Hosted production API. Used when ``api_url`` is omitted.
DEFAULT_API_URL = "https://vet402.com/api/v1"

#: Default per-request timeout in seconds, applied to connect, read, write and
#: pool acquisition alike (httpx applies a bare float to all four).
#:
#: This is not a nicety — it is what makes the fail-closed chain reachable.
#: :class:`~vet402.spend_guard.SpendGuard` can only deny on a lookup that
#: RETURNS; an upstream that accepts the connection and then never answers
#: would leave ``evaluate()`` blocked forever, which is neither an allow nor a
#: deny. A timeout surfaces as an ``httpx.TimeoutException``, which
#: :func:`~vet402.spend_guard.classify_lookup_failure` maps to
#: ``payee_trust_unavailable``.
#:
#: 10 s, matching the TypeScript SDK's ``DEFAULT_REQUEST_TIMEOUT_MS``. It is
#: deliberately looser than ``@vet402/middleware``'s 5000 ms: the
#: middleware answers inside somebody else's HTTP handler, while
#: ``GET /api/v1/payees/{address}/score`` declares ``maxDuration = 30`` for a
#: COLD score. Because the guard fails closed, a bound tighter than the
#: server's own cold path turns a slow-but-correct ALLOW into a denial.
DEFAULT_TIMEOUT_SECONDS = 10.0

_WALLET_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
_TX_HASH_RE = re.compile(r"^0x[a-fA-F0-9]{64}$")
_AGENT_ID_RE = re.compile(r"^\d+$")


def _assert_wallet(wallet: str) -> None:
    if not isinstance(wallet, str) or not _WALLET_RE.match(wallet):
        raise ValueError("invalid_wallet_address")


def _assert_agent_id(agent_id: str) -> None:
    if not isinstance(agent_id, str) or not _AGENT_ID_RE.match(agent_id):
        raise ValueError("invalid_agent_id")


class VouchClient:
    """Synchronous vet402 Trust API client.

    Args:
        api_key: Required. Create one at https://vet402.com/dashboard.
        api_url: Base URL including the ``/api/v1`` suffix. Defaults to the
            hosted production API (:data:`DEFAULT_API_URL`).
        transport: Optional ``httpx.BaseTransport`` — inject
            ``httpx.MockTransport`` in tests to run without a network.
        timeout: Per-request timeout in seconds. Defaults to
            :data:`DEFAULT_TIMEOUT_SECONDS` (10 s) — see there for why the
            bound exists and why it is not the middleware's 5 s.
    """

    def __init__(
        self,
        api_key: str,
        *,
        api_url: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        resolved_url = api_url if api_url is not None else DEFAULT_API_URL
        if not isinstance(resolved_url, str) or resolved_url.strip() == "":
            raise ValueError(
                "invalid_api_url: api_url must be a non-empty URL string "
                f'(e.g. "{DEFAULT_API_URL}") — omit it to use the hosted API'
            )
        if not isinstance(api_key, str) or api_key.strip() == "":
            raise ValueError(
                "invalid_api_key: api_key is required — create one at "
                "https://vet402.com/dashboard"
            )
        self._api_url = resolved_url.rstrip("/")
        self._http = httpx.Client(
            transport=transport,
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def get_agent_score(
        self, agent_id: str, wallet: Optional[str] = None
    ) -> Dict[str, Any]:
        """Score a registered agent (``GET /agents/{id}/score``)."""
        _assert_agent_id(agent_id)
        params: Dict[str, str] = {}
        if wallet is not None:
            _assert_wallet(wallet)
            params["wallet"] = wallet
        return self._request("GET", f"/agents/{agent_id}/score", params=params)

    def get_wallet_score(self, wallet: str) -> Dict[str, Any]:
        """Seller side: "should I accept payment from this wallet?"
        (``GET /wallets/{address}/score``)."""
        _assert_wallet(wallet)
        return self._request("GET", f"/wallets/{wallet}/score")

    def get_payee_score(self, payee: str) -> Dict[str, Any]:
        """Buyer-side lookup: "should my agent pay this wallet?" — scores the
        payment *recipient* (settlement receiving history, wallet health,
        exit-scam-shaped outflow, outcome labels).
        (``GET /payees/{address}/score``).

        The returned dict always carries two fields that gate a payment on
        their own, whatever ``recommendation`` says:

        - ``degraded`` (bool) — at least one input could not be read at all,
          so the body is a fail-closed refusal, not a measurement;
        - ``signalsUnavailable`` (list[str]) — every input that could not be
          read, named (``wallet_metrics``, ``native_drain``, ``usdc_drain``,
          ``outcome_history``). Non-empty with ``degraded`` false is a PARTIAL
          measurement: real numbers, but not all of them.

        **Neither may be treated as ALLOW.**
        :class:`~vet402.spend_guard.SpendGuard` already refuses both
        (``payee_score_degraded`` / ``payee_partial_measurement``); code that
        reads this dict directly must make the same two checks itself.
        """
        _assert_wallet(payee)
        return self._request("GET", f"/payees/{payee}/score")

    def create_spend_guard(
        self,
        *,
        max_per_tx_usd: Optional[float] = None,
        daily_budget_usd: Optional[float] = None,
        trust_policy: SpendGuardTrustPolicy = "allow-only",
        min_payee_score: Optional[float] = None,
        max_score_age_ms: Optional[float] = None,
        block_on_recommendation: bool = False,
    ) -> SpendGuard:
        """Non-custodial spend-policy guard bound to this client.

        Returns allow/deny decisions only — never touches keys, funds, or
        transaction signing; execution remains the agent's wallet stack's job.
        Fail-closed by default: money moves only on a clean ALLOW verdict
        unless the policy explicitly opts out via ``trust_policy``. The daily
        budget counter is in-memory per guard instance and resets on process
        restart. See :class:`~vet402.spend_guard.SpendGuard` for the full
        contract.
        """
        return SpendGuard(
            self.get_payee_score,
            max_per_tx_usd=max_per_tx_usd,
            daily_budget_usd=daily_budget_usd,
            trust_policy=trust_policy,
            min_payee_score=min_payee_score,
            max_score_age_ms=max_score_age_ms,
            block_on_recommendation=block_on_recommendation,
        )

    def batch_score(self, agents: List[Dict[str, str]]) -> Dict[str, Any]:
        """Score up to 25 agents in one call (``POST /scores/batch``)."""
        if not isinstance(agents, list) or len(agents) == 0:
            raise ValueError("invalid_batch")
        return self._request("POST", "/scores/batch", body={"agents": agents})

    def attest_x402_payment(
        self,
        *,
        wallet: str,
        tx_hash: str,
        amount: Optional[str] = None,
        network: Optional[str] = None,
        resource: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Attest a settled x402 payment (``POST /payments/x402``); weights
        future scores."""
        _assert_wallet(wallet)
        if not isinstance(tx_hash, str) or not _TX_HASH_RE.match(tx_hash):
            raise ValueError("invalid_tx_hash")
        body: Dict[str, str] = {"wallet": wallet, "txHash": tx_hash}
        if amount is not None:
            body["amount"] = amount
        if network is not None:
            body["network"] = network
        if resource is not None:
            body["resource"] = resource
        return self._request("POST", "/payments/x402", body=body)

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def __enter__(self) -> "VouchClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, str]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        response = self._http.request(
            method,
            f"{self._api_url}{path}",
            params=params or None,
            json=body,
        )
        data: Union[Dict[str, Any], Any]
        try:
            data = response.json()
        except (json.JSONDecodeError, ValueError):
            data = {}
        if not (200 <= response.status_code < 300):
            code = (
                str(data["error"])
                if isinstance(data, dict) and "error" in data
                else f"vouch_api_error_{response.status_code}"
            )
            raise VouchApiError(code, response.status_code)
        return data if isinstance(data, dict) else {}


def create_vouch_client(
    api_key: str,
    *,
    api_url: Optional[str] = None,
    transport: Optional[httpx.BaseTransport] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> VouchClient:
    """Factory mirroring the TypeScript SDK's ``createVouchClient``."""
    return VouchClient(
        api_key, api_url=api_url, transport=transport, timeout=timeout
    )
