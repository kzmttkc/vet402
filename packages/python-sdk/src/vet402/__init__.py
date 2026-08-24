"""vet402 Python SDK — check a payee before your agent pays, and never pay
without an explicit ALLOW.

Semantics mirror the TypeScript SDK (``@vet402/sdk`` 0.2.x): fail-closed
SpendGuard by default, same machine-readable reason codes, same error
contract.
"""

from .client import (
    DEFAULT_API_URL,
    DEFAULT_TIMEOUT_SECONDS,
    VouchClient,
    create_vouch_client,
)
from .errors import VouchApiError
from .spend_guard import (
    DEFAULT_MAX_SCORE_AGE_MS,
    SpendDecision,
    SpendGuard,
    SpendGuardTrustPolicy,
    classify_lookup_failure,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_API_URL",
    "DEFAULT_MAX_SCORE_AGE_MS",
    "DEFAULT_TIMEOUT_SECONDS",
    "SpendDecision",
    "SpendGuard",
    "SpendGuardTrustPolicy",
    "VouchApiError",
    "VouchClient",
    "classify_lookup_failure",
    "create_vouch_client",
    "__version__",
]
