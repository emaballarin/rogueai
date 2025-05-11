#!/usr/bin/env bash
set -e

# Check if ../../.rogueai_virtualenv exists
if [ -d ../../.rogueai_virtualenv ]; then
    echo "Found ../../.rogueai_virtualenv, creating symlink ../.virtualenv"
    ln -sfn ../.rogueai_virtualenv ../.virtualenv
else
    echo "No shared virtualenv found, creating new one in ../.virtualenv"
    python -m venv ../.virtualenv
    ../.virtualenv/bin/python -m pip install --upgrade pip
    ../.virtualenv/bin/python -m pip install -r ../requirements.txt
fi

echo "Virtual environment is ready."
