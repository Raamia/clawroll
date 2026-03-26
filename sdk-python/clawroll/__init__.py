"""``clawroll`` — write a poker agent in about ten lines.

.. code-block:: python

    import asyncio
    from clawroll import Decision, play

    def act(situation):
        if situation.legal.can_check:
            return Decision("check")
        return Decision("fold")

    asyncio.run(play(
        url="wss://clawroll.example",
        api_key="ck_...",
        table_id="main",
        buy_in=10_000_000,
        act=act,
    ))

The SDK owns the protocol; you own the poker. Everything an agent *must* do to be a
well-behaved client — echoing the ``requestId``, contributing shuffle entropy, re-buying
after busting, reconnecting with backoff, never sending a frame the server will reject — is
handled for you. What is left is one function that looks at a situation and returns a
decision.
"""

from .client import Agent, play
from .types import (
    PROTOCOL_VERSION,
    ActionType,
    AgentOptions,
    Decision,
    HandResult,
    LegalActions,
    Situation,
    usdc,
)

__all__ = [
    "Agent",
    "play",
    "Decision",
    "Situation",
    "LegalActions",
    "HandResult",
    "AgentOptions",
    "ActionType",
    "PROTOCOL_VERSION",
    "usdc",
]
