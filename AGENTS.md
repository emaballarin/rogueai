# `AGENTS.md`: Instructions for Agents

This file defines conventions and best practices for Agents when handling code-related tasks.

---

## General Principles

- **Strive for correctness and robustness**
  Write working, production-ready code. Favor clarity over cleverness.

- **Handle incomplete work explicitly**
  If something cannot be finished, do not leave hidden dependencies or assumptions. Add a concise comment explaining the status.

- **Follow conventions**
  Use established best practices where available. If no standard exists, define a consistent convention and follow it throughout.

- **Design for resilience**
  Anticipate corner cases and handle unexpected inputs gracefully.

- **Keep solutions simple**
  Avoid unnecessary complexity. Build incrementally, but structure code for future extensibility if needed.

- **Use comments sparingly**
  Only comment to clarify intent or non-obvious reasoning. Do not state the obvious.

- **Respect scope**
  When editing existing code, limit changes to the requested modifications. Suggestions for broader improvements are welcome, but must be presented separately.

- **Ask when uncertain**
  If requirements are ambiguous, raise clarifying questions rather than assuming.

- **Error handling**
  Prefer explicit error messages over silent failures.

- **Dependencies**
  Manage external dependencies appropriately; note any new requirements clearly.

- **Documentation**
  Provide at least minimal documentation for modules, functions, and classes. A concise one-line description of purpose is the minimum standard.

---

## Python-Specific Guidelines

- **Use PyTorch where appropriate**
  For vector/matrix/tensor operations, differentiable programming, and machine/deep learning tasks, prefer PyTorch.

- **Add type annotations**
  Use Python’s modern, native type-hinting style. For example:
  - `tuple[int, float]` instead of `Tuple[int, float]`
  - `int | str | None` instead of `Union[int, str, None]`
  - Import abstract collection types from `collections.abc` instead of `typing` when applicable.

- **Code style and linting**
  Format and lint with [Ruff](https://github.com/astral-sh/ruff).
  If available, use the configuration file at `~/ruffconfigs/default/ruff.toml`.

- **Documentation (Python-specific)**
  Use docstrings (`"""..."""`) to describe the purpose of modules, functions, and classes. At minimum, include a one-line summary.
