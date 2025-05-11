#!/usr/bin/env bash

# Use ./.virtualenv/bin/python if available, otherwise use python from PATH
PYTHON="./.virtualenv/bin/python"
if [ ! -x "$PYTHON" ]; then
    PYTHON="python"
fi

exec "$PYTHON" -O ./main.py --prod
