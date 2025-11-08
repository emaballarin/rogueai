# Justfile for rogueai project

# Configuration
ruff_config := env_var('HOME') + "/ruffconfigs/default/ruff.toml"

# Default recipe to display help
[private]
default:
    @just --list

# Display available recipes with descriptions
help:
    @just --list

# Clean Python cache files and directories
clean:
    @find . -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete
    @find . -type d \( -name ".mypy_cache" -o -name "__pycache__" -o -name ".ruff_cache" \) -exec rm -rf {} + 2>/dev/null || true

# Format Python files with ruff, sort requirements, and run prettier
format:
    #!/usr/bin/env bash
    set -euo pipefail

    PYTHON_FILES=$(find . -name "*.py" -type f)
    if [ -n "$PYTHON_FILES" ]; then
        ruff format --config "{{ruff_config}}" . || exit 1
    fi

    REQUIREMENTS_FILES=$(find . -name "requirements.txt" -type f)
    if [ -n "$REQUIREMENTS_FILES" ]; then
        for file in $REQUIREMENTS_FILES; do
            sort-requirements "$file" || exit 1
        done
    fi

    prettier --write .

# Deploy git hooks from .githooks directory
deployhooks:
    #!/usr/bin/env bash
    if [ -d ./.githooks ]; then
        cp -f ./.githooks/* ./.git/hooks/
        chmod +x ./.git/hooks/*
    else
        exit 1
    fi

# Run pre-commit autoupdate
precau:
    @pre-commit autoupdate

# Run pre-commit on all files
precra:
    @pre-commit run --all-files

# Check if git has changes (exits with error if no changes)
check-git-status:
    #!/usr/bin/env bash
    if [ -z "$(git status --porcelain)" ]; then
        exit 1
    fi

# Add all changes, commit, and push to git
gitall: check-git-status
    @git add -A
    @git commit --all
    @git push

# Alias for precra
lint: precra

# Alias for format
fmt: format

# Format, update pre-commit, run pre-commit, and clean
gitpre: format precau precra clean

# Format, update pre-commit, run pre-commit, clean, and push
gitpush: format precau precra clean gitall

# Format and clean
clfmt: format clean

# Run the application
runapp:
    @./start_app.sh

# Clean sessions, stats, and generated stories
cleanup:
    @cd ./scripts/ && ./clean_sessions_and_stats.sh

# Prepare virtual environment
virtualenv:
    @cd ./scripts/ && ./prepare_virtualenv.sh

# Install dependencies with uv
uv-install:
    @uv pip install -r requirements.txt
