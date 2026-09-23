"""Packaging guard: every third-party module the RUNTIME code imports must be a declared runtime
dependency in pyproject.toml.

Why: the installers (install.sh / install.ps1) make a fresh clone and `uv sync`, which installs only
[project].dependencies — not the `dev` extra. httpx was imported by the FLIR link at runtime but only
declared under `dev`, so every fresh install crashed on startup (ModuleNotFoundError), while the dev
checkout worked because httpx had been installed there by hand for tests.
"""

import ast
import re
import sys
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
PACKAGE = BACKEND / "tc_power_interface"

#: import name -> the distribution that provides it (only where they differ, or where a module is
#: guaranteed transitively by a declared dependency).
PROVIDED_BY = {
    "serial": "pyserial",
    "pydantic": "fastapi",  # fastapi hard-requires pydantic
    "starlette": "fastapi",  # fastapi hard-requires starlette
}


def _declared_runtime_deps() -> set[str]:
    data = tomllib.loads((BACKEND / "pyproject.toml").read_text())
    names = set()
    for spec in data["project"]["dependencies"]:
        name = re.split(r"[\[<>=!~;\s]", spec, maxsplit=1)[0]
        names.add(name.lower().replace("_", "-"))
    return names


def _runtime_third_party_imports() -> dict[str, str]:
    """top-level module -> first file that imports it (third-party only)."""
    found: dict[str, str] = {}
    for path in PACKAGE.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                mods = [node.module]
            else:
                continue
            for mod in mods:
                top = mod.split(".")[0]
                if top in sys.stdlib_module_names or top in ("tc_power_interface", "__future__"):
                    continue
                found.setdefault(top, str(path.relative_to(BACKEND)))
    return found


def test_runtime_imports_are_declared_runtime_dependencies():
    declared = _declared_runtime_deps()
    missing = {
        mod: where
        for mod, where in _runtime_third_party_imports().items()
        if PROVIDED_BY.get(mod, mod).lower().replace("_", "-") not in declared
    }
    assert not missing, (
        "runtime code imports packages that are not in [project].dependencies (a fresh install "
        f"would crash): {missing}"
    )
