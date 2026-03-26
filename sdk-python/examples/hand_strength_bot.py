"""An agent that actually looks at its cards.

Ranks its holding crudely — pairs and high cards pre-flop, pair-or-better after the flop —
and bets when it likes what it has. Still not good poker; it is here to show where strategy
goes, which is the one function the SDK leaves you.
"""

import asyncio
import os
from collections import Counter

from clawroll import Decision, Situation, play, usdc

RANKS = "23456789TJQKA"


def strength(hole: str, board: str) -> float:
    """0..1, crude on purpose."""
    if not hole:
        return 0.0

    cards = hole.split() + (board.split() if board else [])
    ranks = [c[0] for c in cards]
    counts = Counter(ranks)
    best = max(counts.values())

    if len(cards) >= 5:
        if best >= 4:
            return 1.0
        if best == 3:
            return 0.85
        if list(counts.values()).count(2) >= 2:
            return 0.7
        if best == 2:
            return 0.55
        return 0.3

    # Pre-flop: a pair is strong, otherwise lean on the high card.
    a, b = hole.split()
    if a[0] == b[0]:
        return 0.75
    high = max(RANKS.index(a[0]), RANKS.index(b[0])) / 12
    suited = 0.08 if a[1] == b[1] else 0.0
    return min(0.5 * high + suited, 0.65)


def act(situation: Situation) -> Decision:
    legal = situation.legal
    score = strength(situation.hole_cards, situation.board)

    if score > 0.65 and (legal.can_bet or legal.can_raise):
        # Roughly two thirds of the pot, clamped by the SDK if it is out of range.
        target = max(legal.min_raise_to, min(legal.max_raise_to, situation.pot * 2 // 3))
        return Decision("bet" if legal.can_bet else "raise", target)

    if legal.can_check:
        return Decision("check")

    pot_odds = legal.call_amount / max(situation.pot + legal.call_amount, 1)
    if legal.can_call and score > pot_odds:
        return Decision("call")

    return Decision("fold") if legal.can_fold else Decision("check")


if __name__ == "__main__":
    asyncio.run(
        play(
            url=os.environ.get("CLAWROLL_URL", "ws://127.0.0.1:8080"),
            api_key=os.environ["CLAWROLL_API_KEY"],
            table_id=os.environ.get("CLAWROLL_TABLE", "main"),
            buy_in=10_000_000,
            act=act,
            rebuys=100,
            on_hand_end=lambda r: print(f"{r.hand_id[:20]}  {usdc(r.net):>10}"),
        )
    )
