"""VouchClient contract tests: request shape, error mapping, validation."""

from __future__ import annotations

import httpx
import pytest

from vet402 import DEFAULT_API_URL, VouchApiError, VouchClient, create_vouch_client

from conftest import PAYEE, make_payee_score


def test_get_payee_score_sends_bearer_and_hits_payees_path(make_client) -> None:
    client, recorder = make_client(
        lambda request: httpx.Response(200, json=make_payee_score())
    )
    result = client.get_payee_score(PAYEE)
    assert result["recommendation"] == "ALLOW"
    request = recorder.requests[0]
    assert request.url.path == f"/api/v1/payees/{PAYEE}/score"
    assert request.headers["Authorization"] == "Bearer vk_test_key"


def test_non_2xx_raises_vouch_api_error_with_api_code(make_client) -> None:
    client, _ = make_client(
        lambda request: httpx.Response(401, json={"error": "missing_api_key"})
    )
    with pytest.raises(VouchApiError) as excinfo:
        client.get_payee_score(PAYEE)
    assert excinfo.value.code == "missing_api_key"
    assert excinfo.value.status == 401
    assert str(excinfo.value) == "missing_api_key"


def test_non_2xx_without_error_body_gets_synthetic_code(make_client) -> None:
    client, _ = make_client(lambda request: httpx.Response(502, text="Bad Gateway"))
    with pytest.raises(VouchApiError) as excinfo:
        client.get_payee_score(PAYEE)
    assert excinfo.value.code == "vouch_api_error_502"
    assert excinfo.value.status == 502


def test_invalid_wallet_rejected_before_any_request(make_client) -> None:
    client, recorder = make_client(lambda request: httpx.Response(200, json={}))
    with pytest.raises(ValueError, match="invalid_wallet_address"):
        client.get_payee_score("0xnot-a-wallet")
    assert recorder.requests == []


def test_empty_api_key_rejected_at_construction() -> None:
    with pytest.raises(ValueError, match="invalid_api_key"):
        VouchClient("   ")


def test_default_api_url_is_hosted_api() -> None:
    assert DEFAULT_API_URL == "https://vet402.com/api/v1"
    client = create_vouch_client("vk_test_key")
    assert client._api_url == DEFAULT_API_URL  # noqa: SLF001 - contract check


def test_trailing_slash_in_api_url_is_stripped(make_client) -> None:
    recorded = []

    def handler(request: httpx.Request) -> httpx.Response:
        recorded.append(str(request.url))
        return httpx.Response(200, json=make_payee_score())

    client = VouchClient(
        "vk_test_key",
        api_url="https://vet402.test/api/v1/",
        transport=httpx.MockTransport(handler),
    )
    client.get_payee_score(PAYEE)
    assert "/api/v1//" not in recorded[0]


def test_attest_x402_payment_validates_tx_hash(make_client) -> None:
    client, recorder = make_client(
        lambda request: httpx.Response(
            200, json={"ok": True, "created": True, "id": "att_1"}
        )
    )
    with pytest.raises(ValueError, match="invalid_tx_hash"):
        client.attest_x402_payment(wallet=PAYEE, tx_hash="0x123")
    assert recorder.requests == []
    result = client.attest_x402_payment(
        wallet=PAYEE, tx_hash="0x" + "11" * 32, resource="/api/premium/data"
    )
    assert result["ok"] is True
    request = recorder.requests[0]
    assert request.url.path == "/api/v1/payments/x402"
    assert b'"txHash"' in request.content


def test_batch_score_rejects_empty_list(make_client) -> None:
    client, _ = make_client(lambda request: httpx.Response(200, json={"results": []}))
    with pytest.raises(ValueError, match="invalid_batch"):
        client.batch_score([])


def test_get_resource_decision_hits_decision_path(make_client) -> None:
    client, recorder = make_client(
        lambda request: httpx.Response(
            200,
            json={"recommendation": "ALLOW", "deliveredRatePct": 91.2},
        )
    )
    result = client.get_resource_decision("res_abc_123")
    assert result["recommendation"] == "ALLOW"
    request = recorder.requests[0]
    assert request.url.path == "/api/v1/resources/res_abc_123/decision"
    assert request.method == "GET"


def test_get_resource_decision_rejects_blank_id(make_client) -> None:
    client, recorder = make_client(lambda request: httpx.Response(200, json={}))
    with pytest.raises(ValueError, match="invalid_resource_id"):
        client.get_resource_decision("   ")
    assert recorder.requests == []


def test_get_agent_score_validates_agent_id(make_client) -> None:
    client, recorder = make_client(
        lambda request: httpx.Response(200, json={"trustScore": 72})
    )
    with pytest.raises(ValueError, match="invalid_agent_id"):
        client.get_agent_score("abc")
    client.get_agent_score("42", wallet=PAYEE)
    request = recorder.requests[0]
    assert request.url.path == "/api/v1/agents/42/score"
    assert request.url.params["wallet"] == PAYEE
