#!/usr/bin/env bash
set -e

# Check if ../../.rogueai_virtualenv exists
if [ -d ../../.rogueai_virtualenv ]; then
    echo "Found ../../.rogueai_virtualenv, creating symlinks ../.virtualenv ../.venv"
    ln -sfn ../.rogueai_virtualenv ../.virtualenv
    ln -sfn ../.rogueai_virtualenv ../.venv
else
    echo "No shared virtualenv found, creating new one with uv in ../.virtualenv, creating symlink ../.venv"
    uv venv ../.virtualenv
    uv pip install --python ../.virtualenv/bin/python -r ../requirements.txt
    ln -sfn ../.virtualenv ../.venv
fi

echo "Virtual environment is ready."
