"""SpendGuard: non-custodial pre-payment policy for agents.

Answers "may my agent send this payment?" and nothing else. It never touches
keys, funds, signing, or transaction submission — execution stays with the
agent's own wallet stack. Semantics mirror the TypeScript SDK's ``SpendGuard``
(``@vet402/sdk`` 0.2.x): fail-closed by default, same machine-readable
reason codes, same optimistic daily-budget reservation.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Literal, Optional

__all__ = [
    "DEFAULT_MAX_SCORE_AGE_MS",
    "SpendDecision",
    "SpendGuard",
    "SpendGuardTrustPolicy",
    "classify_lookup_failure",
]

#: Raw payee score payload as returned by ``GET /api/v1/payees/{address}/score``.
#: Kept as a plain dict on purpose: the guard treats it as untrusted input and
#: fails closed on anything missing or malformed, so a typed wrapper would only
#: hide the fields the guard actually verifies.
PayeeScoreResult = Dict[str, Any]

SpendGuardTrustPolicy = Literal["allow-only", "block-only", "custom"]
"""Trust posture toward the payee score. The default is ``"allow-only"``
(fail-closed): money moves only on a clean ALLOW unless you explicitly opt out.

- ``"allow-only"`` (default): every :meth:`SpendGuard.evaluate` performs the
  payee trust lookup and denies unless the verdict is a clean ALLOW — a WARN
  or BLOCK recommendation, a degraded read, a partial measurement
  (``signalsUnavailable`` non-empty), a stale score, or a failed lookup all
  deny.
- ``"block-only"``: the lookup still always runs and a failed, degraded, or
  stale read still denies, but a WARN (or partially measured) verdict passes.
  Deny only on BLOCK.
- ``"custom"``: only the rules you set apply, and the lookup runs only when
  ``min_payee_score`` or ``block_on_recommendation`` is set.
"""

SpendDenyReason = Literal[
    "max_per_tx_exceeded",
    "daily_budget_exceeded",
    "payee_score_below_min",
    # Recommendation was WARN or BLOCK under the default "allow-only" policy.
    "payee_recommendation_not_allow",
    "payee_recommendation_block",
    # The score itself came from a degraded read (inputs missing entirely).
    "payee_score_degraded",
    # Some inputs could not be measured (signalsUnavailable non-empty).
    "payee_partial_measurement",
    # The score was too old to trust: its scoredAt is older than
    # max_score_age_ms, or it is past its own cacheExpiresAt, or its
    # timestamps could not be parsed. A stale score is not a current
    # measurement.
    "payee_score_stale",
    # The lookup was refused for a credential reason the CALLER owns: the API
    # key is missing, invalid, or not entitled to this endpoint (401/403).
    # Retrying will not help — fix the key.
    "payee_trust_unauthenticated",
    # The score lookup itself failed for a reason on OUR side or in between:
    # network error, timeout, 5xx, rate limit. Retrying may help.
    "payee_trust_unavailable",
]

_WALLET_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")

#: Default staleness bound (5 min), matching the score API's own cache TTL: a
#: score is trusted for exactly as long as the server itself would have served
#: it from cache. See ``SpendGuard``'s ``max_score_age_ms``.
DEFAULT_MAX_SCORE_AGE_MS = 5 * 60 * 1000

#: API error codes that mean "the caller's credentials are the problem".
#: The REST API returns these with a 401. Fallback classification only —
#: status code wins when present. Same set as the TypeScript SDK.
_AUTH_ERROR_CODES = frozenset(
    {"missing_api_key", "invalid_api_key", "forbidden", "unauthorized"}
)


@dataclass(frozen=True)
class SpendDecision:
    """Structured verdict for one prospective payment.

    A DENY is returned as data (``allow=False`` plus reason codes), never
    raised — so the calling agent can branch on it without exception handling.
    """

    allow: bool
    #: Empty when allowed; one or more machine-readable codes when denied.
    reasons: List[SpendDenyReason]
    payee: str
    amount_usd: float
    #: Cumulative USD counted against today's budget after this decision
    #: (includes this payment when allowed).
    spent_today_usd: float
    #: None when the policy has no daily_budget_usd.
    remaining_daily_budget_usd: Optional[float]
    #: Full payee trust result when the Vouch lookup ran and succeeded; None
    #: when the lookup was skipped (a cheaper local rule already denied, or
    #: trust_policy="custom" with no trust rule set) or failed.
    payee_score: Optional[PayeeScoreResult] = field(default=None)


def classify_lookup_failure(error: BaseException) -> SpendDenyReason:
    """Why did the payee lookup fail — the caller's key, or the upstream?

    Distinguished by status code first (structured, from
    :class:`~vet402.errors.VouchApiError`) and by code/message only as a
    fallback, so an injected fetcher in a host app still classifies sensibly.
    401/403 mean the caller's credentials are the problem
    (``payee_trust_unauthenticated``); everything else — network errors,
    timeouts, 5xx, rate limits — is ``payee_trust_unavailable``.
    """
    status = getattr(error, "status", None)
    if isinstance(status, int) and not isinstance(status, bool):
        return (
            "payee_trust_unauthenticated"
            if status in (401, 403)
            else "payee_trust_unavailable"
        )
    code = getattr(error, "code", None)
    token = code if isinstance(code, str) else str(error)
    return (
        "payee_trust_unauthenticated"
        if token in _AUTH_ERROR_CODES
        else "payee_trust_unavailable"
    )


def _parse_iso_ms(value: Any) -> Optional[float]:
    """Parse an ISO-8601 timestamp to epoch milliseconds; None when unparseable."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def _is_score_stale(
    score: PayeeScoreResult, now_ms: float, max_score_age_ms: float
) -> bool:
    """Is this score too old to act on? Fail-closed: an unparseable
    ``scoredAt`` counts as stale (we cannot prove freshness), and the score's
    own ``cacheExpiresAt`` is honoured as a hard ceiling in addition to
    ``max_score_age_ms`` so a lax bound can never resurrect a score past its
    declared expiry.
    """
    scored_at_ms = _parse_iso_ms(score.get("scoredAt"))
    if scored_at_ms is None:
        return True
    if now_ms - scored_at_ms > max_score_age_ms:
        return True
    expires_ms = _parse_iso_ms(score.get("cacheExpiresAt"))
    if expires_ms is not None and now_ms >= expires_ms:
        return True
    return False


def _positive_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value  # rejects NaN
        and value != float("inf")
        and value != float("-inf")
    )


class SpendGuard:
    """Pre-payment policy guard. Same contract as the TypeScript SDK.

    The guard composes:

    1. Local policy — per-transaction cap (``max_per_tx_usd``) and an
       in-memory daily budget counter (``daily_budget_usd``, UTC day, resets
       on process restart, not shared across replicas).
    2. Vouch's Payee Trust API (``GET /api/v1/payees/{address}/score``) —
       consulted on every evaluate under the default fail-closed policy
       (skipped when a local rule already denied, so no quota is burned on a
       payment that's dead anyway). Only ``trust_policy="custom"`` makes the
       lookup conditional on ``min_payee_score`` / ``block_on_recommendation``
       being set.

    Fail-closed by default (``trust_policy="allow-only"``): a WARN or BLOCK
    recommendation, a degraded read, a partial measurement, a stale score, or
    a failed lookup all deny. Money moves only on a clean ALLOW unless the
    integrator explicitly opts out via ``trust_policy``.

    Budget reservation is optimistic: once the local rules pass, the amount is
    reserved against the daily budget BEFORE the trust lookup runs, and
    returned automatically if the trust rules then deny. The counter is
    guarded by a lock, so concurrent ``evaluate`` calls from multiple threads
    cannot both read the pre-reservation counter and slip past the budget
    together. If the agent ultimately does NOT execute an allowed payment,
    call :meth:`release` to return the reservation.
    """

    def __init__(
        self,
        fetch_payee_score: Callable[[str], PayeeScoreResult],
        *,
        max_per_tx_usd: Optional[float] = None,
        daily_budget_usd: Optional[float] = None,
        trust_policy: SpendGuardTrustPolicy = "allow-only",
        min_payee_score: Optional[float] = None,
        max_score_age_ms: Optional[float] = None,
        block_on_recommendation: bool = False,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        for name, value in (
            ("max_per_tx_usd", max_per_tx_usd),
            ("daily_budget_usd", daily_budget_usd),
            ("min_payee_score", min_payee_score),
        ):
            if value is not None and (not _positive_number(value) or value < 0):
                raise ValueError(f"invalid_policy_{name}")
        if min_payee_score is not None and min_payee_score > 100:
            raise ValueError("invalid_policy_min_payee_score")
        if max_score_age_ms is not None:
            # Allows +Infinity (disable the age bound; cacheExpiresAt still caps).
            is_number = isinstance(max_score_age_ms, (int, float)) and not isinstance(
                max_score_age_ms, bool
            )
            if not is_number or max_score_age_ms != max_score_age_ms or max_score_age_ms <= 0:
                raise ValueError("invalid_policy_max_score_age_ms")
        if trust_policy not in ("allow-only", "block-only", "custom"):
            raise ValueError("invalid_policy_trust_policy")

        self._fetch_payee_score = fetch_payee_score
        self._max_per_tx_usd = max_per_tx_usd
        self._daily_budget_usd = daily_budget_usd
        self._trust_policy: SpendGuardTrustPolicy = trust_policy
        self._min_payee_score = min_payee_score
        self._max_score_age_ms = (
            max_score_age_ms if max_score_age_ms is not None else DEFAULT_MAX_SCORE_AGE_MS
        )
        self._block_on_recommendation = block_on_recommendation
        self._now = now
        self._lock = threading.Lock()
        self._spent_today_usd: float = 0.0
        self._current_day: str = self._utc_day()

    def evaluate(self, payee: str, amount_usd: float) -> SpendDecision:
        """Evaluate one prospective payment. Returns a structured decision;
        never raises on DENY (only on invalid arguments)."""
        if not isinstance(payee, str) or not _WALLET_RE.match(payee):
            raise ValueError("invalid_payee_address")
        if not _positive_number(amount_usd) or amount_usd <= 0:
            raise ValueError("invalid_amount_usd")

        reasons: List[SpendDenyReason] = []
        reserved = False

        with self._lock:
            self._roll_day_if_needed()
            if self._max_per_tx_usd is not None and amount_usd > self._max_per_tx_usd:
                reasons.append("max_per_tx_exceeded")
            if (
                self._daily_budget_usd is not None
                and self._spent_today_usd + amount_usd > self._daily_budget_usd
            ):
                reasons.append("daily_budget_exceeded")
            # Optimistic reservation: once the local rules pass, take the
            # amount out of today's budget BEFORE the trust lookup runs.
            # Otherwise two concurrent evaluate() calls could both read the
            # same pre-reservation counter while their lookups were in flight
            # and jointly overshoot the budget (TOCTOU). A trust-rule deny
            # returns it below.
            if not reasons:
                self._spent_today_usd += amount_usd
                reserved = True

        payee_score: Optional[PayeeScoreResult] = None
        # Fail-closed default: "allow-only" and "block-only" always vet the
        # payee. Only the explicit "custom" opt-out makes the lookup
        # conditional on a trust rule being configured.
        needs_trust_lookup = (
            self._trust_policy != "custom"
            or self._min_payee_score is not None
            or self._block_on_recommendation
        )

        if needs_trust_lookup and not reasons:
            try:
                payee_score = self._fetch_payee_score(payee)
            except Exception as error:  # noqa: BLE001 - fail closed on anything
                reasons.append(classify_lookup_failure(error))
            if payee_score is not None:
                self._apply_trust_rules(payee_score, reasons)

        allow = not reasons
        with self._lock:
            if not allow and reserved:
                # Trust rules denied after the optimistic reservation — give
                # it back. Roll the day first: if the UTC day flipped while
                # the lookup was in flight, the counter was already reset and
                # the release must clamp at 0 instead of dragging the fresh
                # day's counter negative.
                self._roll_day_if_needed()
                self._spent_today_usd = max(0.0, self._spent_today_usd - amount_usd)
            spent_today = self._spent_today_usd

        return SpendDecision(
            allow=allow,
            reasons=reasons,
            payee=payee,
            amount_usd=amount_usd,
            spent_today_usd=spent_today,
            remaining_daily_budget_usd=(
                max(0.0, self._daily_budget_usd - spent_today)
                if self._daily_budget_usd is not None
                else None
            ),
            payee_score=payee_score,
        )

    def _apply_trust_rules(
        self, score: PayeeScoreResult, reasons: List[SpendDenyReason]
    ) -> None:
        """Apply the trust-policy verdict rules, most fundamental defect
        first: a degraded read is not a measurement at all, a stale one is no
        longer current, a partial measurement is not a clean one, and only
        then does the recommendation itself get a say. All reads are tolerant
        of tampered or malformed payloads and fail closed.
        """
        recommendation = score.get("recommendation")
        signals_unavailable = score.get("signalsUnavailable")
        partial = isinstance(signals_unavailable, list) and len(signals_unavailable) > 0
        now_ms = self._now().timestamp() * 1000
        # Freshness gate: enforced under the fail-closed policies, not under
        # the pre-0.2.0-equivalent "custom" opt-out.
        stale = self._trust_policy != "custom" and _is_score_stale(
            score, now_ms, self._max_score_age_ms
        )

        if self._trust_policy == "allow-only":
            if score.get("degraded") is True:
                reasons.append("payee_score_degraded")
            elif stale:
                reasons.append("payee_score_stale")
            elif partial:
                reasons.append("payee_partial_measurement")
            elif recommendation != "ALLOW":
                reasons.append("payee_recommendation_not_allow")
        elif self._trust_policy == "block-only":
            if score.get("degraded") is True:
                reasons.append("payee_score_degraded")
            elif stale:
                reasons.append("payee_score_stale")
            elif recommendation == "BLOCK":
                reasons.append("payee_recommendation_block")

        # Explicit rules compose on top in every mode.
        if self._min_payee_score is not None:
            raw_score = score.get("score")
            score_value = (
                float(raw_score)
                if isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool)
                else None
            )
            # Fail closed: a missing or non-numeric score cannot clear a floor.
            if score_value is None or score_value < self._min_payee_score:
                reasons.append("payee_score_below_min")
        if (
            self._block_on_recommendation
            and recommendation == "BLOCK"
            and "payee_recommendation_block" not in reasons
        ):
            reasons.append("payee_recommendation_block")

    def release(self, amount_usd: float) -> None:
        """Return a previously reserved amount to today's budget. Call when an
        allowed payment ultimately did not execute."""
        if not _positive_number(amount_usd) or amount_usd <= 0:
            raise ValueError("invalid_amount_usd")
        with self._lock:
            self._roll_day_if_needed()
            self._spent_today_usd = max(0.0, self._spent_today_usd - amount_usd)

    def state(self) -> Dict[str, Any]:
        """Current in-memory budget state (UTC day + reserved USD)."""
        with self._lock:
            self._roll_day_if_needed()
            return {"day": self._current_day, "spent_today_usd": self._spent_today_usd}

    def _roll_day_if_needed(self) -> None:
        day = self._utc_day()
        if day != self._current_day:
            self._current_day = day
            self._spent_today_usd = 0.0

    def _utc_day(self) -> str:
        return self._now().astimezone(timezone.utc).strftime("%Y-%m-%d")
