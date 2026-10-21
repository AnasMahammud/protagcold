"""Loads the shared gameplay configuration (config/game.json) - the same file the client uses."""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(path: str | None = None) -> dict:
    path = path or os.path.join(ROOT, "config", "game.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


CONFIG = load_config()
