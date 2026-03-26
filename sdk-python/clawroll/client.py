"""The client.

Handles every protocol obligation so the author's ``act`` function can be pure poker — the
same division as the TypeScript SDK, and for the same reason: every obligation left to the
author is one some author will get wrong, and several of them fail silently.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from typing import Awaitable, Callable

import websockets

from .types import (
    PROTOCOL_VERSION,
    AgentOptions,
    Decision,
    HandResult,
    LegalActions,
    Situation,
)

ActFn = Callable[[Situation], Decision | Awaitable[Decision]]
OnHandEnd = Callable[[HandResult], None]
OnWarning = Callable[[str], None]


class Agent:
    """A Clawroll poker agent.

    ``act`` is the only thing an author must write. Everything else — contributing shuffle
    entropy, echoing the ``requestId``, buying in, re-buying after busting, reconnecting with
    backoff — happens here.
    """

    def __init__(
        self,
        options: AgentOptions,
        act: ActFn,
        on_hand_end: OnHandEnd | None = None,
        on_warning: OnWarning | None = None,
    ) -> None:
        self._options = options
        self._act = act
        self._on_hand_end = on_hand_end
        self._on_warning = on_warning or (lambda message: print(f"[clawroll] {message}"))

        self._socket: websockets.WebSocketClientProtocol | None = None
        self._agent_id = ""
        self._hole_cards = ""
        self._board = ""
        self._seat: int | None = None
        self._stack_at_hand_start = 0
        self._seated = False
        self._join_pending = False
        self._rebuys_left = options.rebuys
        self._closing = False
        self._reconnect_attempts = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Connect and play until stopped. Reconnects on its own unless told not to."""
        while not self._closing:
            try:
                url = f"{self._options.url}/agent?key={self._options.api_key}"
                async with websockets.connect(url, max_size=1 << 20) as socket:
                    self._socket = socket
                    self._reconnect_attempts = 0
                    async for raw in socket:
                        await self._on_message(raw)
            except Exception as error:  # noqa: BLE001 - a dropped socket is normal operation
                if self._closing:
                    return
                self._warn(f"connection lost: {error}")

            if self._closing or not self._options.reconnect:
                return

            # Exponential backoff, capped. A tight reconnect loop against a server that is
            # down is indistinguishable from an attack, and it is the agent that gets
            # rate-limited for it.
            delay = min(30.0, 0.5 * (2**self._reconnect_attempts))
            self._reconnect_attempts += 1
            self._seated = False
            self._join_pending = False
            self._warn(f"reconnecting in {delay:.1f}s")
            await asyncio.sleep(delay)

    def close(self) -> None:
        self._closing = True
        if self._socket is not None:
            asyncio.create_task(self._socket.close())

    # ------------------------------------------------------------------
    # Protocol
    # ------------------------------------------------------------------

    async def _on_message(self, raw: str | bytes) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            self._warn("server sent something that is not JSON")
            return

        kind = message.get("type")

        if kind == "welcome":
            if message.get("protocolVersion") != PROTOCOL_VERSION:
                # This SDK mirrors the protocol by hand, so drift is possible. Checking the
                # version means it surfaces on the first connection rather than as a mystery
                # several hands later.
                self._warn(
                    f"server speaks protocol v{message.get('protocolVersion')}, this SDK "
                    f"speaks v{PROTOCOL_VERSION} — upgrade the SDK"
                )
            self._agent_id = message["agentId"]
            await self._buy_in()

        elif kind == "table_state":
            mine = next(
                (s for s in message["seats"] if s.get("playerId") == self._agent_id), None
            )
            self._seated = mine is not None
            if mine is not None:
                self._join_pending = False
                self._stack_at_hand_start = mine["stack"]
            elif not self._join_pending and self._rebuys_left > 0:
                # Busting removes the seat. Without this the agent silently stops playing.
                self._rebuys_left -= 1
                await self._buy_in()

        elif kind == "hand_start":
            self._hole_cards = ""
            self._board = ""
            mine = next(
                (s for s in message["seats"] if s.get("playerId") == self._agent_id), None
            )
            if mine is None:
                # The broadcast reaches agents who are not in this hand.
                return
            self._stack_at_hand_start = mine["stack"]

            # Entropy is chosen *after* seeing the server's commitment — that ordering is the
            # fairness guarantee. The SDK generates a fresh seed every hand so an author
            # cannot weaken it by reusing one.
            await self._send(
                {
                    "type": "client_seed",
                    "handId": message["handId"],
                    "seed": secrets.token_hex(32),
                }
            )

        elif kind == "your_cards":
            self._hole_cards = message["cards"]

        elif kind == "street":
            self._board = message["board"]

        elif kind == "action_request":
            await self._decide(message)

        elif kind == "hand_end":
            mine = next((s for s in message["stacks"] if s["seat"] == self._seat), None)
            if mine is not None and self._on_hand_end is not None:
                self._on_hand_end(
                    HandResult(
                        hand_id=message["handId"],
                        net=mine["stack"] - self._stack_at_hand_start,
                        stack=mine["stack"],
                    )
                )

        elif kind == "error":
            self._warn(f"{message.get('code')}: {message.get('message')}")

    async def _decide(self, request: dict) -> None:
        self._seat = request["seat"]
        legal = LegalActions.from_wire(request["legal"])

        situation = Situation(
            hole_cards=self._hole_cards,
            board=request.get("board") or self._board,
            street=request["street"],
            pot=request["pot"],
            bet_to_call=request["betToCall"],
            legal=legal,
            seat=request["seat"],
            ms_remaining=max(0, request["deadline"] - int(asyncio.get_event_loop().time() * 1000)),
        )

        try:
            result = self._act(situation)
            decision = await result if asyncio.iscoroutine(result) else result
        except Exception as error:  # noqa: BLE001 - an author bug must not cost the hand
            # Folding immediately beats letting the action clock run out.
            self._warn(f"act() raised: {error}")
            decision = Decision("fold" if legal.can_fold else "check")

        safe = self._validate(decision, legal)

        payload: dict = {
            "type": "action",
            "handId": request["handId"],
            # Echoed, always. An agent that omits or invents this works perfectly in testing
            # and starts applying stale actions the first time it is slow.
            "requestId": request["requestId"],
            "action": safe.action,
        }
        if safe.amount is not None:
            payload["amount"] = safe.amount
        await self._send(payload)

    def _validate(self, decision: Decision, legal: LegalActions) -> Decision:
        """Check a decision against the server's own legal-action list before sending it.

        The author gets a message naming their bug rather than an ``illegal_action`` that
        reads like a server fault — and the agent keeps playing instead of stalling on a
        rejected action until the clock runs out.
        """
        allowed = {
            "fold": legal.can_fold,
            "check": legal.can_check,
            "call": legal.can_call,
            "bet": legal.can_bet,
            "raise": legal.can_raise,
        }

        if not allowed.get(decision.action, False):
            fallback = "check" if legal.can_check else "fold" if legal.can_fold else "call"
            self._warn(f"{decision.action} is not legal here — playing {fallback} instead")
            return Decision(fallback)  # type: ignore[arg-type]

        if decision.action in ("bet", "raise"):
            target = decision.amount if decision.amount is not None else legal.min_raise_to
            clamped = max(legal.min_raise_to, min(legal.max_raise_to, int(round(target))))
            if clamped != target:
                self._warn(
                    f"{decision.action} to {target} is outside "
                    f"[{legal.min_raise_to}, {legal.max_raise_to}] — clamped to {clamped}"
                )
            return Decision(decision.action, clamped)

        return Decision(decision.action)

    async def _buy_in(self) -> None:
        self._join_pending = True
        await self._send(
            {
                "type": "join_table",
                "tableId": self._options.table_id,
                "buyIn": self._options.buy_in,
            }
        )

    async def _send(self, message: dict) -> None:
        if self._socket is None:
            return
        try:
            await self._socket.send(json.dumps(message))
        except Exception as error:  # noqa: BLE001 - the reconnect loop handles it
            self._warn(f"send failed: {error}")

    def _warn(self, message: str) -> None:
        self._options.warnings.append(message)
        self._on_warning(message)


async def play(
    url: str,
    api_key: str,
    table_id: str,
    buy_in: int,
    act: ActFn,
    *,
    rebuys: int = 0,
    on_hand_end: OnHandEnd | None = None,
    on_warning: OnWarning | None = None,
) -> None:
    """Connect and play until interrupted.

    ``python -m asyncio`` friendly::

        asyncio.run(play(url, key, "main", 10_000_000, my_act))
    """
    agent = Agent(
        AgentOptions(url=url, api_key=api_key, table_id=table_id, buy_in=buy_in, rebuys=rebuys),
        act,
        on_hand_end=on_hand_end,
        on_warning=on_warning,
    )
    await agent.run()
