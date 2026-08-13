"""Decision validation — the logic that protects an author from their own bugs.

## Why this file exists

The Python SDK had no tests at all. That was tolerable while it was repo-local; it is not once
it is on PyPI, because this module independently reimplements logic the TypeScript SDK has
covered by integration tests. Two implementations of the same rules, one of them unverified, is
how they drift apart without anyone noticing.

Deliberately scoped to ``Agent._validate``: pure, synchronous, no server, no sockets, no
fixtures. The full connect-sit-play path stays covered by ``packages/sdk-ts/src/client.test.ts``,
which runs a real engine against a real Postgres — worth doing once, not twice.

## What is being protected

An author who raises beyond their stack should get a message naming *their* bug and keep
playing, rather than an ``illegal_action`` from the server that reads like a server fault and
costs them the hand on the action clock. Every case below is a mistake a real bot makes.
"""

from __future__ import annotations

import pytest

from clawroll.client import Agent
from clawroll.types import AgentOptions, Decision, LegalActions


def make_agent(warnings: list[str]) -> Agent:
    """An Agent that never connects — `_validate` touches no I/O."""
    options = AgentOptions(
        url="ws://127.0.0.1:8080",
        api_key="ck_test",
        table_id="main",
        buy_in=5_000_000,
    )
    return Agent(options, act=lambda s: Decision("check"), on_warning=warnings.append)


def legal(**overrides) -> LegalActions:
    """Facing a bet of 100, with a raise to between 200 and 5000 available."""
    base = dict(
        can_fold=True,
        can_check=False,
        can_call=True,
        call_amount=100,
        can_bet=False,
        can_raise=True,
        min_raise_to=200,
        max_raise_to=5000,
    )
    base.update(overrides)
    return LegalActions(**base)


class TestLegalDecisionsPassThrough:
    def test_a_legal_action_is_untouched(self) -> None:
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("call"), legal())
        assert result.action == "call"
        assert warnings == []

    def test_a_raise_inside_the_range_keeps_its_amount(self) -> None:
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("raise", 1000), legal())
        assert result.action == "raise"
        assert result.amount == 1000
        assert warnings == []


class TestClamping:
    def test_a_raise_beyond_the_stack_is_clamped_down(self) -> None:
        # The classic bot bug: raise the pot without checking it against your own stack.
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("raise", 999_999_999), legal())
        assert result.amount == 5000
        assert len(warnings) == 1
        # The message must name the author's number, not just say "invalid" — otherwise they
        # have no idea which line of their bot produced it.
        assert "999999999" in warnings[0].replace(",", "").replace("_", "")

    def test_a_raise_below_the_minimum_is_clamped_up(self) -> None:
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("raise", 1), legal())
        assert result.amount == 200
        assert len(warnings) == 1

    def test_a_raise_with_no_amount_becomes_the_minimum(self) -> None:
        # `Decision("raise")` with no amount is a plausible thing to write; guessing the
        # minimum is friendlier than rejecting it.
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("raise"), legal())
        assert result.amount == 200


class TestIllegalActionsAreSubstituted:
    def test_checking_when_facing_a_bet_becomes_a_legal_action(self) -> None:
        # An always-check bot must not stall the table. Substituting keeps it playing and tells
        # the author what happened.
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("check"), legal())
        assert result.action in {"call", "fold"}
        assert len(warnings) == 1

    def test_checking_is_preferred_over_folding_when_available(self) -> None:
        # Folding a hand that could be checked for free is the worst possible substitution.
        warnings: list[str] = []
        can_check = legal(can_check=True, can_call=False, call_amount=0)
        result = make_agent(warnings)._validate(Decision("bet"), can_check)
        assert result.action == "check"

    def test_betting_when_only_raising_is_legal_is_substituted(self) -> None:
        warnings: list[str] = []
        result = make_agent(warnings)._validate(Decision("bet", 500), legal())
        assert result.action != "bet"
        assert len(warnings) == 1


@pytest.mark.parametrize("action", ["fold", "check", "call", "bet", "raise"])
def test_every_action_type_is_handled_without_raising(action: str) -> None:
    """No input to `_validate` may throw.

    It runs inside the action-request handler, so an exception here does not merely fail a
    decision — it takes down the message loop and the agent stops playing entirely.
    """
    warnings: list[str] = []
    result = make_agent(warnings)._validate(Decision(action), legal())  # type: ignore[arg-type]
    assert result.action in {"fold", "check", "call", "bet", "raise"}
