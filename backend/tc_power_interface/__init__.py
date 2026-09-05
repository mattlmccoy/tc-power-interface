"""T&C Power Conversion AG-series RF generator control interface.

Simulator-first, safety-first backend for driving a T&C RF generator over its documented
CXN serial protocol, streaming telemetry, and (in later phases) closing a thermal control
loop with the FLIR Research Interface.

The wire protocol is implemented from the documented CXN command set (see plan/notes.md).
RF output defaults OFF and there is no automatic RF-enable in this prototype.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
