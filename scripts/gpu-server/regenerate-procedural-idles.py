#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from gpu_services.livetalking_gateway.procedural_idle import generate_procedural_idle


def main() -> int:
    parser = argparse.ArgumentParser(description="Regenerate deterministic ECHO procedural idle loops.")
    parser.add_argument("avatar_ids", nargs="+")
    parser.add_argument(
        "--service-root",
        type=Path,
        default=Path("/home/user/echo/services/livetalking"),
    )
    parser.add_argument("--seconds", type=float, default=12.0)
    parser.add_argument("--fps", type=int, default=25)
    args = parser.parse_args()

    service_root = args.service_root.resolve()
    results: dict[str, dict] = {}
    for avatar_id in args.avatar_ids:
        avatar_root = service_root / "data" / "avatars" / avatar_id
        if not avatar_root.is_dir():
            raise FileNotFoundError(f"avatar package does not exist: {avatar_root}")
        results[avatar_id] = generate_procedural_idle(
            avatar_root / "full_imgs",
            avatar_root / "coords.pkl",
            avatar_root / "idle_imgs",
            avatar_id,
            seconds=args.seconds,
            fps=args.fps,
        )
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
