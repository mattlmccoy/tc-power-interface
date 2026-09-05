"""Device layer: transport registry + factory (mirrors FLIR's backend registry).

Concrete transports register themselves with :func:`register_transport` and are created by
name with :func:`create_transport`. The ``simulated`` transport is always available; the
``serial`` transport is imported lazily so the prototype has no hard dependency on a port.
"""

from __future__ import annotations

from collections.abc import Callable

from tc_power_interface.device.base import Telemetry, Transport

_REGISTRY: dict[str, Callable[..., Transport]] = {}


def register_transport(name: str) -> Callable[[Callable[..., Transport]], Callable[..., Transport]]:
    """Class/factory decorator that registers a transport under ``name``."""

    def decorator(factory: Callable[..., Transport]) -> Callable[..., Transport]:
        _REGISTRY[name] = factory
        return factory

    return decorator


def create_transport(name: str, **kwargs: object) -> Transport:
    """Create a registered transport by name.

    :raises KeyError: if ``name`` is not registered.
    """
    if name not in _REGISTRY:
        raise KeyError(f"unknown transport {name!r}; registered: {sorted(_REGISTRY)}")
    return _REGISTRY[name](**kwargs)


# Import for self-registration side effects. Simulated is always safe to import; the serial
# transport only touches a port when actually constructed, so importing it here is harmless.
from tc_power_interface.device import serial_backend as _serial_backend  # noqa: E402,F401
from tc_power_interface.device import simulated as _simulated  # noqa: E402,F401

__all__ = ["Telemetry", "Transport", "register_transport", "create_transport"]
