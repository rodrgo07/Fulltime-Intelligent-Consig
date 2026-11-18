"""Driver do teste ponta a ponta (supabase/tests/robot-e2e.test.ts).

Roda o Worker REAL com o fluxo falso contra um PostgREST simulado sobre o banco PGlite.
Uso: python e2e_driver.py <url> <pasta-de-dados> <voltas>
Imprime uma linha JSON por volta com o resultado de tick().
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fic_robot.api import SupabaseApi, Tokens  # noqa: E402
from fic_robot.browser import NoBrowser  # noqa: E402
from fic_robot.flows import select_flow  # noqa: E402
from fic_robot.pending import PendingResults  # noqa: E402
from fic_robot.worker import RestartRequested, Worker  # noqa: E402


def main() -> int:
    url, data_dir, rounds = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])
    os.environ["FIC_FAKE_FLOW"] = "1"
    api = SupabaseApi(url, "sb_publishable_teste")
    api.tokens = Tokens("token-de-teste", "refresh-de-teste", "aal2")
    worker = Worker(api, NoBrowser(), select_flow(), PendingResults(data_dir / "pending-results.json"),
                    "pc-e2e", "2.0.0")
    for _ in range(rounds):
        try:
            outcome = worker.tick()
        except RestartRequested:
            outcome = "restart"
        print(json.dumps({"outcome": outcome, "paused": worker.paused}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
