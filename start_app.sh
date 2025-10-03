#!/usr/bin/env bash

# Use uv run if pyproject.toml exists and virtualenv is set up, otherwise fallback
if [ -f "./pyproject.toml" ] && [ -d "./.virtualenv" ]; then
    exec uv run --python ./.virtualenv/bin/python python -O ./main.py --prod
elif [ -x "./.virtualenv/bin/python" ]; then
    exec ./.virtualenv/bin/python -O ./main.py --prod
else
    exec python -O ./main.py --prod
fi
