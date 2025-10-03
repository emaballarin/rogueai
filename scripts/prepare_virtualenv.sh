#!/usr/bin/env bash
set -e

# Check if ../../.rogueai_virtualenv exists
if [ -d ../../.rogueai_virtualenv ]; then
    echo "Found ../../.rogueai_virtualenv, creating symlink ../.virtualenv"
    ln -sfn ../.rogueai_virtualenv ../.virtualenv
    ln -sfn ../.rogueai_virtualenv ../.venv
else
    echo "No shared virtualenv found, creating new one with uv in ../.virtualenv"
    uv venv ../.virtualenv
    uv pip install --python ../.virtualenv/bin/python -r ../requirements.txt
fi

echo "Virtual environment is ready."
