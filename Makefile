RUFF_CONFIG := ~/ruffconfigs/default/ruff.toml
PYTHON_FILES := $(shell find . -name "*.py" -type f)
REQUIREMENTS_FILES := $(shell find . -name "requirements.txt" -type f)

.PHONY: help clean format deployhooks precau precra gitall check-git-status runapp cleanup virtualenv uv-sync uv-install

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

clean:
	@find . -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete
	@find . -type d \( -name ".mypy_cache" -o -name "__pycache__" -o -name ".ruff_cache" \) -exec rm -rf {} + 2>/dev/null || true

format:
	@if [ -n "$(PYTHON_FILES)" ]; then \
		ruff format --config "$(RUFF_CONFIG)" . || exit 1; \
	fi
	@if [ -n "$(REQUIREMENTS_FILES)" ]; then \
		for file in $(REQUIREMENTS_FILES); do \
			sort-requirements "$$file" || exit 1; \
		done; \
	fi
	prettier --write .

deployhooks:
	@if [ -d ./.githooks ]; then \
		cp -f ./.githooks/* ./.git/hooks/ && \
		chmod +x ./.git/hooks/* && \
	else \
		exit 1; \
	fi

precau:
	@pre-commit autoupdate

precra:
	@pre-commit run --all-files

check-git-status:
	@if [ -z "$$(git status --porcelain)" ]; then \
		exit 1; \
	fi

gitall: check-git-status
	@git add -A
	@git commit --all
	@git push


lint: precra
fmt: format

gitpre: format precau precra clean
gitpush: format precau precra clean gitall
clfmt: format clean

runapp:
	@./start_app.sh

cleanup:
	@cd ./scripts/ && ./clean_sessions_and_stats.sh

virtualenv:
	@cd ./scripts/ && ./prepare_virtualenv.sh

uv-sync:  ## Sync dependencies using uv
	@uv sync

uv-install:  ## Install dependencies using uv pip
	@uv pip install -r requirements.txt
