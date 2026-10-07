"""/api/scope/* — settings, connect/disconnect, VISA resource discovery.

Read-only w.r.t. the generator: no route here reaches the controller."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request

from tc_power_interface.integration.scope_hub import ScopeHub
from tc_power_interface.integration.scope_settings import settings_from_dict

__all__ = ["router"]

router = APIRouter(prefix="/api/scope")


def _hub(request: Request) -> ScopeHub:
    return cast(ScopeHub, request.app.state.scope_hub)


@router.get("")
def scope_status(request: Request) -> dict[str, Any]:
    return _hub(request).snapshot()


@router.get("/resources")
def scope_resources(request: Request) -> dict[str, Any]:
    try:
        return {"resources": _hub(request).resources()}
    except Exception as exc:  # noqa: BLE001 - VISA backend missing / libusb absent
        raise HTTPException(503, f"VISA unavailable: {exc}") from exc


@router.post("/settings")
def scope_settings(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """Partial update: top-level keys replace, nested geometry/limits merge key-by-key."""
    hub = _hub(request)
    cur = asdict(hub.settings)
    try:
        merged = settings_from_dict({
            **cur, **body,
            "geometry": {**cur["geometry"], **body.get("geometry", {})},
            "limits": {**cur["limits"], **body.get("limits", {})},
        })
    except (TypeError, ValueError) as exc:  # unknown nested key / bad limits or geometry
        raise HTTPException(422, str(exc)) from exc
    try:
        hub.update_settings(merged)
    except OSError as exc:  # could not persist: nothing was applied
        raise HTTPException(500, f"could not save scope settings: {exc}") from exc
    return hub.snapshot()


@router.post("/connect")
def scope_connect(request: Request) -> dict[str, Any]:
    try:
        _hub(request).connect()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return _hub(request).snapshot()


@router.post("/disconnect")
def scope_disconnect(request: Request) -> dict[str, Any]:
    _hub(request).disconnect()
    return _hub(request).snapshot()
