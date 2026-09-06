"""Software tuner-cap PRESETS: 9 slots each storing a {tune%, load%} capacitor position.

The AG Plasma manual's native PRESETS are *"only available in ATUNE (automatic tuning)"* — and
ATUNE is the forbidden built-in auto-tuner. So these presets are **software** slots: recall applies
the stored positions by driving the caps in MANUAL (MTUNE) mode. Recall sets manual mode FIRST, so
it can never route through ATUNE. Persisted to a git-ignored ``.presets.json`` sidecar.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CONFIG_NAME = ".presets.json"
NUM_SLOTS = 9
CAP_MIN, CAP_MAX = 0, 100


def _clamp_cap(v: float) -> int:
    return int(max(CAP_MIN, min(round(v), CAP_MAX)))


def _check_slot(slot: int) -> int:
    if not (1 <= slot <= NUM_SLOTS):
        raise ValueError(f"preset slot must be 1..{NUM_SLOTS}, got {slot}")
    return slot


class PresetStore:
    """Nine tuner-cap preset slots, persisted to ``root/.presets.json``."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._slots: dict[int, dict[str, int]] = {}
        self._load()

    def _path(self) -> Path:
        return self._root / CONFIG_NAME

    def _load(self) -> None:
        try:
            raw = json.loads(self._path().read_text())
        except (FileNotFoundError, ValueError):
            return
        for k, v in raw.items():
            try:
                slot = _check_slot(int(k))
            except ValueError:
                continue
            self._slots[slot] = {
                "tune_cap_percent": _clamp_cap(v.get("tune_cap_percent", 0)),
                "load_cap_percent": _clamp_cap(v.get("load_cap_percent", 0)),
            }

    def _save(self) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        self._path().write_text(json.dumps({str(k): v for k, v in self._slots.items()}, indent=2))

    def save(self, slot: int, *, tune: float, load: float) -> dict[str, int]:
        _check_slot(slot)
        entry = {"tune_cap_percent": _clamp_cap(tune), "load_cap_percent": _clamp_cap(load)}
        self._slots[slot] = entry
        self._save()
        return entry

    def clear(self, slot: int) -> None:
        _check_slot(slot)
        self._slots.pop(slot, None)
        self._save()

    def recall(self, slot: int, controller: Any) -> dict[str, int] | None:
        _check_slot(slot)
        entry = self._slots.get(slot)
        if entry is None:
            return None
        # Manual mode FIRST — this recall never engages the forbidden ATUNE preset path.
        controller.set_manual_mode(True)
        controller.set_tune_capacity(entry["tune_cap_percent"])
        controller.set_load_capacity(entry["load_cap_percent"])
        return dict(entry)

    def list(self) -> dict[int, dict[str, int] | None]:
        return {slot: self._slots.get(slot) for slot in range(1, NUM_SLOTS + 1)}
