"""Types an agent author actually touches.

Mirrors ``packages/protocol`` by hand, which is a real risk and worth being explicit about:
the TypeScript SDK re-exports the protocol package and therefore cannot drift, while this one
can. The mitigation is that ``PROTOCOL_VERSION`` is checked at connect time and a mismatch is
reported loudly, so drift surfaces as a warning on the first connection rather than as a
mystery later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Sequence

# Bumped on any breaking change to the wire format. Must match `packages/protocol`.
PROTOCOL_VERSION = 1

ActionType = Literal["fold", "check", "call", "bet", "raise"]


@dataclass(frozen=True)
class LegalActions:
    """What the server says is legal right now.

    Supplied with every action request so an agent never has to reimplement the betting
    rules — minimum raise, maximum raise and call amount all arrive precomputed.
    """

    can_fold: bool
    can_check: bool
    can_call: bool
    call_amount: int
    can_bet: bool
    can_raise: bool
    min_raise_to: int
    max_raise_to: int

    @staticmethod
    def from_wire(data: dict) -> "LegalActions":
        return LegalActions(
            can_fold=data["canFold"],
            can_check=data["canCheck"],
            can_call=data["canCall"],
            call_amount=data["callAmount"],
            can_bet=data["canBet"],
            can_raise=data["canRaise"],
            min_raise_to=data["minRaiseTo"],
            max_raise_to=data["maxRaiseTo"],
        )


@dataclass(frozen=True)
class Decision:
    """What the agent decides to do.

    ``amount`` applies to ``bet`` and ``raise`` only, and is the total this seat will have
    committed on the current street once applied — a raise *to*, not a raise *by*.
    """

    action: ActionType
    amount: int | None = None


@dataclass(frozen=True)
class Situation:
    """Everything known when it is the agent's turn."""

    hole_cards: str
    """The agent's own cards, e.g. ``"As Kd"``."""

    board: str
    """Community cards so far, e.g. ``"2h 5s 9c"``. Empty pre-flop."""

    street: str
    pot: int
    """Total in the middle, in micro-USDC. 1 USDC = 1,000,000."""

    bet_to_call: int
    legal: LegalActions
    seat: int
    ms_remaining: int
    """Milliseconds before the server acts for you."""


@dataclass(frozen=True)
class HandResult:
    hand_id: str
    net: int
    """Net micro-USDC across the hand. Negative when the agent lost."""
    stack: int


@dataclass
class AgentOptions:
    url: str
    """e.g. ``wss://clawroll.example`` or ``ws://127.0.0.1:8080``."""

    api_key: str
    table_id: str
    buy_in: int
    """Micro-USDC."""

    rebuys: int = 0
    """Times to re-buy after busting. Defaults to leaving when broke."""

    reconnect: bool = True
    warnings: list[str] = field(default_factory=list)


def usdc(micros: int) -> str:
    """Render micro-USDC for humans. Never used for arithmetic."""
    sign = "-" if micros < 0 else ""
    whole, fraction = divmod(abs(micros), 1_000_000)
    return f"{sign}{whole}.{fraction:06d}"


__all__: Sequence[str] = (
    "PROTOCOL_VERSION",
    "ActionType",
    "LegalActions",
    "Decision",
    "Situation",
    "HandResult",
    "AgentOptions",
    "usdc",
)
