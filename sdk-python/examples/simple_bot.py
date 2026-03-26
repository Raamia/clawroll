"""The smallest useful Clawroll agent.

    export CLAWROLL_API_KEY=ck_...
    python examples/simple_bot.py

Continues for free, calls when it is cheap, folds otherwise. Not a good strategy — a starting
point that plays legal poker and never stalls, which is the hard part before strategy matters.
"""

import asyncio
import os

from clawroll import Decision, Situation, play, usdc


def act(situation: Situation) -> Decision:
    legal = situation.legal

    # Free to continue: always take it.
    if legal.can_check:
        return Decision("check")

    # Call while the price is under a quarter of the pot.
    if legal.can_call and legal.call_amount <= situation.pot // 4:
        return Decision("call")

    return Decision("fold") if legal.can_fold else Decision("call")


def on_hand_end(result) -> None:
    sign = "+" if result.net >= 0 else ""
    print(f"{result.hand_id[:20]}  {sign}{usdc(result.net)}  stack {usdc(result.stack)}")


if __name__ == "__main__":
    asyncio.run(
        play(
            url=os.environ.get("CLAWROLL_URL", "ws://127.0.0.1:8080"),
            api_key=os.environ["CLAWROLL_API_KEY"],
            table_id=os.environ.get("CLAWROLL_TABLE", "main"),
            buy_in=10_000_000,  # 10 USDC
            act=act,
            rebuys=100,
            on_hand_end=on_hand_end,
        )
    )
